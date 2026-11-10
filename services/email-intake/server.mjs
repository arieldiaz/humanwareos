import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {QueueConsumer, RawObjects} from './queue.mjs';
import {timingSafeEqual} from 'node:crypto';
import {readFileSync, realpathSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Store} from './store.mjs';
import {Intake, calendarClient} from './intake.mjs';
import {SessionAdapter} from './sessions.mjs';
import {SlackAdapter} from './slack.mjs';

function authorized(actual, expected) {
  if (!actual || !expected) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function handler(intake, secret, transport = null) {
  return async (request, response) => {
    const send = (status, value) => { response.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store'}); response.end(JSON.stringify(value)); };
    try {
      if (request.method === 'GET' && request.url === '/health') { const value = intake.health(); if (transport) { value.queueReady = transport.healthy(); value.ok &&= value.queueReady; } return send(value.ok ? 200 : 503, value); }
      // This slice has no trusted Slack promotion transport. Mail credentials
      // cannot authenticate a human Slack event, even with copied actor fields.
      if (request.url === '/promote') return send(403, {error: 'trusted_slack_promotion_required'});
      if (request.method !== 'POST' || !['/inbound/email', '/inbound/dead-letter'].includes(request.url)) return send(404, {error: 'not_found'});
      if (!authorized(request.headers['x-email-intake-secret'], secret)) return send(401, {error: 'unauthorized'});
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 768 * 1024) return send(413, {error: 'oversized'}); chunks.push(chunk); }
      let event;
      try { event = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, {error: 'invalid_json'}); }
      return send(200, await (request.url.endsWith('dead-letter') ? intake.deadLetter(event) : intake.receive(event)));
    } catch (error) { return send(error.status ?? 503, {error: error.status ? error.message : 'intake_unavailable'}); }
  };
}

export function ownersOf(config) { return [...new Set(Object.values(config.routes ?? {}))]; }

export function isMainModule(moduleUrl, argvPath) {
  return Boolean(argvPath) && moduleUrl === pathToFileURL(realpathSync(argvPath)).href;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.umask(0o077);
  // <runtime>/framework/services/email-intake/server.mjs → <runtime>
  const runtime = process.env.HUMANWARE_RUNTIME_ROOT ?? join(import.meta.dirname, '..', '..', '..');
  const data = process.env.HUMANWARE_DATA_ROOT;
  if (!data) throw new Error('HUMANWARE_DATA_ROOT is required');
  const configPath = process.env.EMAIL_INTAKE_CONFIG ?? join(runtime, 'config/services/email-intake/config.json');
  const config = JSON.parse(readFileSync(configPath));
  const stateDir = process.env.EMAIL_INTAKE_DATA_DIR ?? join(data, 'working/projects/email-intake');
  const channel = JSON.parse(readFileSync(join(runtime, 'config/channels/slack.json'))).registry.inbox;
  const secret = process.env.EMAIL_INTAKE_SECRET;
  if (!secret || !process.env.CALENDAR_INGEST_SECRET) throw new Error('intake_credentials_missing');
  const tokenSecretId = config.queue?.tokenSecretId, rawSecretId = config.raw?.tokenSecretId;
  if (!tokenSecretId || !rawSecretId) throw new Error('email-intake config.queue.tokenSecretId and config.raw.tokenSecretId are required');
  const store = new Store(join(stateDir, 'intake.sqlite3'), {tablePrefix: config.tablePrefix});
  // One Slack bot per routed owner; tokens come from <OWNER>_SLACK_BOT_TOKEN.
  const tokens = Object.fromEntries(ownersOf(config).map(owner => [owner, process.env[`${owner.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_SLACK_BOT_TOKEN`]]));
  const slack = new SlackAdapter({channel, tokens, eventType: config.slackEventType});
  // Protected provider output is captured in-process, never shell interpolation,
  // argv, a file, or diagnostics.
  let values;
  try {
    values = JSON.parse(execFileSync(join(runtime, 'framework/ops/openclaw/runtime/secret-exec.sh'), [], {
      input: JSON.stringify({protocolVersion: 1, provider: 'email-intake', ids: [tokenSecretId, rawSecretId]}),
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 30000
    })).values ?? {};
  } catch { throw new Error('cloudflare_credential_unavailable'); }
  const token = values[tokenSecretId];
  const objects = new RawObjects({accountId: config.queue.accountId, bucket: config.raw.bucket, token: values[rawSecretId]});
  const intake = new Intake({store, config, channel, slack, objects, sessions: new SessionAdapter({store, directory: join(stateDir, 'requests')}), calendar: calendarClient({url: config.calendarUrl, secret: process.env.CALENDAR_INGEST_SECRET})});
  const transport = new QueueConsumer({config: config.queue, token, intake, directory: join(stateDir, 'dead-letter')});
  const server = http.createServer({requestTimeout: 30000}, handler(intake, secret, transport));
  // Bind before any dispatcher starts: a second supervised instance cannot send.
  server.listen(Number(process.env.EMAIL_INTAKE_PORT ?? 8795), '127.0.0.1', () => {
    let running = null, stopping = false, failure = null;
    const tick = () => {
      if (running || stopping) return;
      running = (async () => {
        try {
          await intake.exclusive(async () => { await intake.verify(); await intake.drain(); });
          await transport.tick();
          failure = null;
        } catch (error) {
          // Log each new bounded code once; a silent stall looks like an empty inbox.
          if (failure !== error.message) console.error(JSON.stringify({event: 'email_intake_tick_failed', code: String(error.message).slice(0, 80)}));
          failure = error.message; intake.ready = false;
        }
      })().finally(() => { running = null; });
    };
    tick();
    const timer = setInterval(tick, 5000);
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
      stopping = true; clearInterval(timer); server.close(() => { Promise.resolve(running).then(() => intake.serial).finally(() => { store.close(); process.exit(0); }); });
    });
  });
}
