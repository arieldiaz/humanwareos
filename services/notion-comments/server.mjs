import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {NotionClient, validSignature} from './notion.mjs';
import {Store} from './store.mjs';
import {Channel} from './channel.mjs';

// Each agent connection has its own webhook subscription and verification token.
// The token comes from the secret manager when the instance stored it there;
// otherwise it is the one captured from that subscription's handshake. The first
// captured token is never replaced by a later unsigned request.
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

export function handler({channel, store, tokens, maxBytes = 256 * 1024}) {
  return async (request, response) => {
    const send = (status, value) => { response.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'}); response.end(JSON.stringify(value)); };
    try {
      if (request.method === 'GET' && request.url === '/health') {
        const verified = Object.fromEntries(Object.entries(tokens).map(([agent, token]) => [agent, Boolean(token.get())]));
        const value = {...store.health(), verified};
        value.ok = value.sqlite && Object.values(verified).every(Boolean) && value.held === 0;
        return send(value.ok ? 200 : 503, value);
      }
      const agentId = request.method === 'POST' && /^\/webhook\/notion\/([a-z0-9_-]+)$/.exec(request.url ?? '')?.[1];
      const token = agentId && Object.hasOwn(tokens, agentId) ? tokens[agentId] : null;
      if (!token) return send(404, {error: 'not_found'});
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
      const accepted = channel.receive(agentId, body);
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
  const agentIds = Object.keys(config.agents ?? {});
  if (!config.ownerUserId || !agentIds.length || agentIds.some(id => !/^[a-z0-9_-]+$/.test(id) || !config.agents[id].secrets?.notionToken)) {
    throw new Error('notion-comments config requires ownerUserId and agents.<id>.secrets.notionToken');
  }
  const stateDir = config.dataDir ?? join(data, 'working/projects/notion-comments');
  mkdirSync(join(stateDir, 'verification-tokens'), {recursive: true, mode: 0o700});
  const values = resolveSecrets(runtime, agentIds.flatMap(id => [config.agents[id].secrets.notionToken, config.agents[id].secrets.verificationToken]).filter(Boolean));
  const notion = {}, agents = {}, tokens = {};
  for (const id of agentIds) {
    const {secrets, aliases} = config.agents[id];
    if (!values[secrets.notionToken]) throw new Error(`notion_token_missing_${id}`);
    notion[id] = new NotionClient({token: values[secrets.notionToken], version: config.notionVersion});
    agents[id] = {aliases: aliases ?? [id], botUserId: (await notion[id].me()).id};
    tokens[id] = new VerificationToken({path: join(stateDir, 'verification-tokens', id), secret: values[secrets.verificationToken] ?? null});
  }
  const store = new Store(join(stateDir, 'comments.sqlite3'));
  store.holdInterrupted();
  const channel = new Channel({store, notion, agents, config, requestsDir: join(stateDir, 'requests'), log: (...args) => console.error('notion-comments', ...args)});
  const server = http.createServer({requestTimeout: 30000}, handler({channel, store, tokens}));
  server.listen(Number(config.port ?? 8797), '127.0.0.1', () => {
    channel.drain(); // also resumes waiting on every persisted run id
    const timer = setInterval(() => channel.drain(), 30000);
    // Waiting rows keep their run id, so stopping mid-wait is safe and resumes on restart.
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
      clearInterval(timer);
      server.close(() => channel.serial.finally(() => { store.close(); process.exit(0); }));
    });
  });
}
