import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {NotionClient, validSignature} from './notion.mjs';
import {Store} from './store.mjs';
import {Channel} from './channel.mjs';

// The verification token comes from the secret manager when the instance has
// stored it there; otherwise it is the one captured from Notion's handshake.
// The first captured token is never replaced by a later unsigned request.
export class VerificationToken {
  constructor({path, secret = null}) { Object.assign(this, {path, secret}); }
  get() {
    if (this.secret) return this.secret;
    try { return readFileSync(this.path, 'utf8').trim() || null; } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  capture(value) {
    if (typeof value !== 'string' || !value || this.get()) return false;
    writeFileSync(this.path, value, {mode: 0o600, flag: 'wx'});
    return true;
  }
}

export function handler({channel, store, token, maxBytes = 256 * 1024}) {
  return async (request, response) => {
    const send = (status, value) => { response.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'}); response.end(JSON.stringify(value)); };
    try {
      if (request.method === 'GET' && request.url === '/health') {
        const value = {...store.health(), verified: Boolean(token.get())};
        value.ok = value.sqlite && value.verified && value.held === 0;
        return send(value.ok ? 200 : 503, value);
      }
      if (request.method !== 'POST' || request.url !== '/webhook/notion') return send(404, {error: 'not_found'});
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > maxBytes) return send(413, {error: 'oversized'}); chunks.push(chunk); }
      const raw = Buffer.concat(chunks);
      let body;
      try { body = JSON.parse(raw.toString('utf8')); } catch { return send(400, {error: 'invalid_json'}); }
      // One-time subscription handshake. The token value is stored privately and never logged or echoed.
      if (body && typeof body.verification_token === 'string' && body.type === undefined) return send(200, {captured: token.capture(body.verification_token)});
      const secret = token.get();
      if (!secret) return send(503, {error: 'verification_pending'});
      if (!validSignature(raw, request.headers['x-notion-signature'], secret)) return send(401, {error: 'invalid_signature'});
      const accepted = channel.receive(body);
      if (accepted) channel.drain();
      return send(200, {accepted});
    } catch { return send(503, {error: 'unavailable'}); }
  };
}

export function isMainModule(moduleUrl, argvPath) {
  return Boolean(argvPath) && moduleUrl === pathToFileURL(realpathSync(argvPath)).href;
}

function resolveSecrets(runtime, ids) {
  // Values are captured in-process from the instance secret manager, never argv or logs.
  try {
    return JSON.parse(execFileSync(join(runtime, 'framework/ops/openclaw/runtime/secret-exec.sh'), [], {
      input: JSON.stringify({protocolVersion: 1, provider: 'notion-comments', ids}),
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 30000,
    })).values ?? {};
  } catch { throw new Error('notion_comments_credentials_unavailable'); }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.umask(0o077);
  // <runtime>/framework/services/notion-comments/server.mjs -> <runtime>
  const runtime = process.env.HUMANWARE_RUNTIME_ROOT ?? join(import.meta.dirname, '..', '..', '..');
  const data = process.env.HUMANWARE_DATA_ROOT;
  if (!data) throw new Error('HUMANWARE_DATA_ROOT is required');
  const config = JSON.parse(readFileSync(process.env.NOTION_COMMENTS_CONFIG ?? join(runtime, 'config/services/notion-comments/config.json')));
  if (!config.ownerUserId || !config.secrets?.notionToken) throw new Error('notion-comments config requires ownerUserId and secrets.notionToken');
  const stateDir = config.dataDir ?? join(data, 'working/projects/notion-comments');
  const ids = [config.secrets.notionToken, config.secrets.verificationToken].filter(Boolean);
  const values = resolveSecrets(runtime, ids);
  if (!values[config.secrets.notionToken]) throw new Error('notion_token_missing');
  const store = new Store(join(stateDir, 'comments.sqlite3'));
  store.holdInterrupted();
  const token = new VerificationToken({path: join(stateDir, 'verification-token'), secret: values[config.secrets.verificationToken] ?? null});
  const notion = new NotionClient({token: values[config.secrets.notionToken], version: config.notionVersion});
  const botUserId = (await notion.me()).id;
  const channel = new Channel({store, notion, config, botUserId, log: (...args) => console.error('notion-comments', ...args)});
  const server = http.createServer({requestTimeout: 30000}, handler({channel, store, token}));
  server.listen(Number(config.port ?? 8797), '127.0.0.1', () => {
    channel.drain();
    const timer = setInterval(() => channel.drain(), 30000);
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
      clearInterval(timer);
      server.close(() => channel.serial.finally(() => { store.close(); process.exit(0); }));
    });
  });
}
