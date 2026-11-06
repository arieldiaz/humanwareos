import http from 'node:http';
import {execFile} from 'node:child_process';
import {createReadStream, readFileSync, realpathSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {SlackPoster, Store, VoiceIntake, ollamaSummarizer, whisperTranscriber} from './intake.mjs';

const exec = promisify(execFile);
const HEADERS = {'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff'};
const MESSAGES = {accepted: 'Sent to Liv', duplicate: 'Already sent to Liv'};

function send(response, status, value) {
  response.writeHead(status, {...HEADERS, 'content-type': 'application/json; charset=utf-8'});
  response.end(JSON.stringify(value));
}

function health(intake, response) {
  const value = {...intake.store.health(), ready: intake.ready !== false};
  value.ok = value.sqlite && value.ready && value.held === 0;
  return send(response, value.ok ? 200 : 503, value);
}

// Capture listener: the only target of the edge tunnel, which enforces the
// Cloudflare Access service token before a request reaches loopback.
export function captureHandler(intake, {maxBytes = 50 * 1024 * 1024} = {}) {
  return async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health') return health(intake, response);
      if (request.method !== 'POST' || request.url !== '/capture') return send(response, 404, {error: 'not_found'});
      const type = request.headers['content-type'] ?? '';
      if (!type.startsWith('multipart/form-data')) return send(response, 415, {error: 'multipart_required', message: 'Not sent: bad request'});
      const chunks = []; let size = 0;
      // Multipart framing adds a little to the payload limit.
      for await (const chunk of request) { size += chunk.length; if (size > maxBytes + 64 * 1024) return send(response, 413, {error: 'oversized', message: 'Not sent: recording too large'}); chunks.push(chunk); }
      let form;
      try { form = await new Response(Buffer.concat(chunks), {headers: {'content-type': type}}).formData(); } catch { return send(response, 400, {error: 'invalid_form', message: 'Not sent: bad request'}); }
      const result = await intake.accept(form);
      intake.drain();
      return send(response, result.status === 'accepted' ? 202 : 200, {...result, message: MESSAGES[result.status]});
    } catch (error) {
      return error.status ? send(response, error.status, {error: error.message, message: `Not sent: ${error.message}`}) : send(response, 503, {error: 'unavailable', message: 'Not sent: intake unavailable'});
    }
  };
}

// Audio listener: reached only through the private domain's existing access
// boundary. It serves stored captures by id with byte ranges for media players.
export function audioHandler(intake) {
  return async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') return health(intake, response);
    const id = request.method === 'GET' && /^\/audio\/([0-9a-f]{32})$/.exec(request.url ?? '')?.[1];
    const row = id && intake.store.get(id);
    if (!row || row.kind !== 'audio') return send(response, 404, {error: 'not_found'});
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
    let start = 0, end = row.bytes - 1;
    if (range) {
      start = range[1] ? Number(range[1]) : Math.max(0, row.bytes - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), end) : end;
      if (start > end || start >= row.bytes) { response.writeHead(416, {...HEADERS, 'content-range': `bytes */${row.bytes}`}); return response.end(); }
    }
    response.writeHead(range ? 206 : 200, {...HEADERS, 'content-type': row.media_type, 'accept-ranges': 'bytes', 'content-length': end - start + 1,
      'content-disposition': `inline; filename="${id}.${row.evidence_path.split('.').pop()}"`, ...(range ? {'content-range': `bytes ${start}-${end}/${row.bytes}`} : {})});
    createReadStream(row.evidence_path, {start, end}).pipe(response);
  };
}

export async function gatewayCall(method, params) {
  // The CLI resolves gateway credentials from protected configuration. The message
  // carries only the request-record path, so no transcript is placed in argv.
  const {stdout} = await exec(process.env.OPENCLAW_BIN ?? 'openclaw', ['gateway', 'call', method, '--params', JSON.stringify(params), '--json', '--timeout', '15000'], {timeout: 20000, maxBuffer: 1024 * 1024});
  return JSON.parse(stdout);
}

export function isMainModule(moduleUrl, argvPath) {
  return Boolean(argvPath) && moduleUrl === pathToFileURL(realpathSync(argvPath)).href;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.umask(0o077);
  // <runtime>/framework/services/voice-intake/server.mjs -> <runtime>
  const runtime = process.env.HUMANWARE_RUNTIME_ROOT ?? join(import.meta.dirname, '..', '..', '..');
  const data = process.env.HUMANWARE_DATA_ROOT;
  if (!data) throw new Error('HUMANWARE_DATA_ROOT is required');
  const config = JSON.parse(readFileSync(process.env.VOICE_INTAKE_CONFIG ?? join(runtime, 'config/services/voice-intake/config.json')));
  if (!config.agentId || !config.privateOrigin || !config.timeZone) throw new Error('voice-intake config requires agentId, privateOrigin, and timeZone');
  const token = process.env.VOICE_INTAKE_SLACK_BOT_TOKEN;
  if (!token) throw new Error('voice_intake_slack_token_missing');
  const channel = JSON.parse(readFileSync(join(runtime, 'config/channels/slack.json'))).registry[config.slackChannel ?? 'inbox'];
  const {slackApi} = await import('../../ops/openclaw/plugins/run-signature/plugin-runtime.mjs');
  const stateDir = config.dataDir ?? join(data, 'working/projects/voice-intake');
  const store = new Store(join(stateDir, 'captures.sqlite3'));
  const slack = new SlackPoster({channel, token, call: slackApi});
  const intake = new VoiceIntake({store, config, slack, gateway: gatewayCall, requestsDir: join(stateDir, 'requests'),
    evidenceRoot: config.evidenceRoot ?? join(data, 'evidence/voice/captures'),
    transcribe: whisperTranscriber(config.whisper), summarize: ollamaSummarizer(config.summary)});
  const tick = async () => { try { await slack.verify(); intake.ready = true; await intake.drain(); } catch { intake.ready = false; } };
  const capture = http.createServer({requestTimeout: 120000}, captureHandler(intake, {maxBytes: config.maxBytes}));
  const audio = http.createServer({requestTimeout: 30000}, audioHandler(intake));
  capture.listen(Number(config.capturePort ?? 8800), '127.0.0.1');
  audio.listen(Number(config.audioPort ?? 8801), '127.0.0.1', () => {
    tick();
    const timer = setInterval(tick, 30000);
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
      clearInterval(timer);
      capture.close(); audio.close(() => intake.serial.finally(() => { store.close(); process.exit(0); }));
    });
  });
}
