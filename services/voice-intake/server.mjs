import http from 'node:http';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createReadStream, readFileSync, realpathSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {SlackPoster, Store, VoiceIntake, audioGuard, ollamaSummarizer} from './intake.mjs';
import {whisperCppTranscriber} from './transcriber.mjs';

const exec = promisify(execFile);
const HEADERS = {'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff'};
// What the Shortcut shows for each outcome; reason codes stay in the service log.
const MESSAGES = {
  empty_audio: 'Recording was empty', empty_text: 'Recording was empty', audio_or_text_required: 'Recording was empty',
  audio_not_file: 'Not sent: recording was not attached', oversized: 'Not sent: recording too large',
  unsupported_audio: 'Not sent: recording format not supported', text_too_long: 'Not sent: dictation too long',
  silent_audio: 'Recording was silent: check the Mac\'s input device in System Settings → Sound', too_short: 'Recording was too short',
  form_required: 'Not sent: upload unreadable', invalid_form: 'Not sent: upload unreadable', unavailable: 'Mini unavailable: try again soon',
};

function send(response, status, value) {
  response.writeHead(status, {...HEADERS, 'content-type': 'application/json; charset=utf-8'});
  response.end(JSON.stringify(value));
}

function health(intake, response) {
  const value = {...intake.store.health(), ready: intake.ready !== false};
  value.ok = value.sqlite && value.ready && value.held === 0;
  return send(response, value.ok ? 200 : 503, value);
}

const reject = (status, reason) => Object.assign(new Error(reason), {status});
const params = (value) => Object.fromEntries([...value.matchAll(/;\s*([^=;\s]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g)]
  .map(([, key, quoted, bare]) => [key.toLowerCase(), quoted != null ? quoted.replace(/\\(.)/g, '$1') : bare.trim()]));
const extended = (value) => { try { return decodeURIComponent(value.replace(/^[^']*'[^']*'/, '')); } catch { return value; } };

// Parses a capture form without trusting any one client's framing: any boundary
// (declared or, failing that, read from the first line), CRLF or bare LF line
// ends, a missing closing delimiter, and plain or RFC 5987 file names. A
// urlencoded form is accepted too, so a text-only upload is never refused.
export function parseForm(body, type = '') {
  const media = type.split(';')[0].trim().toLowerCase();
  const form = new FormData();
  if (media === 'application/x-www-form-urlencoded') {
    for (const [key, value] of new URLSearchParams(body.toString('utf8'))) form.append(key, value);
    return form;
  }
  const sniffed = /^(?:\r?\n)*--([^\r\n]{1,200}?)[ \t]*\r?\n/.exec(body.subarray(0, 256).toString('latin1'))?.[1];
  if (media !== 'multipart/form-data' && !sniffed) throw reject(415, 'form_required');
  const boundary = params(type).boundary || sniffed;
  const delimiter = boundary && Buffer.from(`--${boundary}`);
  let at = delimiter ? body.indexOf(delimiter) : -1;
  if (at < 0) throw reject(400, 'invalid_form');
  while (body.subarray(at + delimiter.length, at + delimiter.length + 2).toString('latin1') !== '--') {
    const start = body.indexOf('\n', at + delimiter.length) + 1;
    if (!start) break;
    const next = body.indexOf(delimiter, start);
    let part = body.subarray(start, next < 0 ? body.length : next);
    if (part.at(-1) === 0x0a) part = part.subarray(0, part.at(-2) === 0x0d ? -2 : -1);
    const split = /\r?\n\r?\n/.exec(part.subarray(0, 16 * 1024).toString('latin1'));
    if (!split) throw reject(400, 'invalid_form');
    const headers = Object.fromEntries(part.subarray(0, split.index).toString('utf8').split(/\r?\n/)
      .map(line => /^([^:]+):\s*(.*)$/.exec(line)).filter(Boolean).map(([, key, value]) => [key.trim().toLowerCase(), value]));
    const disposition = params(headers['content-disposition'] ?? '');
    const content = part.subarray(split.index + split[0].length);
    const filename = disposition['filename*'] != null ? extended(disposition['filename*']) : disposition.filename;
    if (disposition.name != null) {
      if (filename != null) form.append(disposition.name, new File([content], filename || 'upload', {type: headers['content-type'] ?? ''}));
      else form.append(disposition.name, content.toString('utf8'));
    }
    if (next < 0) break;
    at = next;
  }
  return form;
}

// Capture listener: the only target of the edge tunnel, which enforces the
// Cloudflare Access service token before a request reaches loopback. Every
// rejection is logged with its reason and request framing, never the body or
// the Access headers.
export function captureHandler(intake, {maxBytes = 50 * 1024 * 1024, channel = 'inbox', log = (entry) => console.error(JSON.stringify(entry))} = {}) {
  const sent = {accepted: `Sent ✓ — check #${channel}`, duplicate: `Already sent ✓ — check #${channel}`};
  return async (request, response) => {
    const requestId = randomUUID();
    const fail = (status, reason, detail) => {
      log({at: new Date().toISOString(), event: 'capture_rejected', requestId, status, reason, contentType: request.headers['content-type'] ?? null,
        contentLength: request.headers['content-length'] ?? null, ...(detail ? {detail} : {})});
      send(response, status, {error: reason, requestId, message: MESSAGES[reason] ?? 'Not sent: bad request'});
    };
    try {
      if (request.method === 'GET' && request.url === '/health') return health(intake, response);
      if (request.method !== 'POST' || request.url !== '/capture') return send(response, 404, {error: 'not_found'});
      const chunks = []; let size = 0;
      // Multipart framing adds a little to the payload limit.
      for await (const chunk of request) { size += chunk.length; if (size > maxBytes + 64 * 1024) return fail(413, 'oversized'); chunks.push(chunk); }
      const result = await intake.accept(parseForm(Buffer.concat(chunks), request.headers['content-type']));
      intake.drain();
      return send(response, result.status === 'accepted' ? 202 : 200, {...result, requestId, message: sent[result.status]});
    } catch (error) {
      return error.status ? fail(error.status, error.message) : fail(503, 'unavailable', error.message);
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
  // Optional owner token: root and transcript appear as the owner, never mentioning the agent.
  const userToken = process.env.VOICE_INTAKE_SLACK_USER_TOKEN;
  const channel = JSON.parse(readFileSync(join(runtime, 'config/channels/slack.json'))).registry[config.slackChannel ?? 'inbox'];
  const {slackApi} = await import('../../ops/openclaw/plugins/run-signature/plugin-runtime.mjs');
  const stateDir = config.dataDir ?? join(data, 'working/projects/voice-intake');
  const store = new Store(join(stateDir, 'captures.sqlite3'));
  const slack = new SlackPoster({channel, token, userToken, call: slackApi});
  const intake = new VoiceIntake({store, config, slack, gateway: gatewayCall, requestsDir: join(stateDir, 'requests'),
    evidenceRoot: config.evidenceRoot ?? join(data, 'evidence/voice/captures'),
    transcribe: whisperCppTranscriber(config.transcriber), summarize: ollamaSummarizer(config.summary), guard: audioGuard(config.audioGuard)});
  const tick = async () => { try { await slack.verify(); intake.ready = true; await intake.drain(); } catch { intake.ready = false; } };
  const capture = http.createServer({requestTimeout: 120000}, captureHandler(intake, {maxBytes: config.maxBytes, channel: config.slackChannel ?? 'inbox'}));
  const audio = http.createServer({requestTimeout: 30000}, audioHandler(intake));
  capture.listen(Number(config.capturePort ?? 8800), '127.0.0.1');
  audio.listen(Number(config.audioPort ?? 8801), '127.0.0.1', () => {
    tick();
    const timer = setInterval(tick, 30000);
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
      clearInterval(timer);
      capture.close(); audio.close(() => intake.idle().finally(() => { store.close(); process.exit(0); }));
    });
  });
}
