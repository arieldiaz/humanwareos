import http from 'node:http';
import {execFile} from 'node:child_process';
import {timingSafeEqual} from 'node:crypto';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_BODY_BYTES = 16 * 1024;
const MAX_TEXT_CHARS = 12_000;

function authorized(header, expected) {
  const prefix = 'Bearer ';
  if (!header?.startsWith(prefix) || !expected) return false;
  const actual = Buffer.from(header.slice(prefix.length));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function responseJson(response, status, value) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('oversized');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('invalid_json');
    error.status = 400;
    throw error;
  }
}

function voicePrompt(text) {
  return [
    '[Authenticated Ariel voice interface]',
    'Answer for spoken playback: lead with the result, use concise plain language, and avoid Markdown unless it materially helps.',
    'When asked to inspect or change Slack, use the session-scoped slack_workspace tool and report only confirmed results.',
    'Do not add, remove, or replace Slack root status reactions; those remain human-controlled.',
    '',
    text,
  ].join('\n');
}

function extractResult(stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error('invalid_openclaw_response');
  }
  if (value.status !== 'ok') throw new Error('openclaw_turn_failed');
  const reply = value.result?.payloads
    ?.map((payload) => payload?.text)
    .filter((text) => typeof text === 'string' && text.trim())
    .join('\n')
    .trim();
  if (!reply) throw new Error('empty_openclaw_reply');
  return {
    reply,
    runId: value.runId ?? null,
    durationMs: value.result?.meta?.durationMs ?? null,
  };
}

export function openClawTurn(options = {}) {
  const command = options.command ?? process.env.OPENCLAW_BIN ?? '/opt/homebrew/bin/openclaw';
  const sessionKey = options.sessionKey ?? process.env.VOICE_AGENT_SESSION_KEY ?? 'agent:liv:voice-chief-of-staff';
  const tempRoot = options.tempRoot ?? process.env.VOICE_AGENT_TEMP_ROOT ?? tmpdir();
  const timeoutMs = options.timeoutMs ?? Number(process.env.VOICE_AGENT_TIMEOUT_MS ?? 180_000);
  const execute = options.execute ?? execFileAsync;

  return async (text) => {
    await mkdir(tempRoot, {recursive: true, mode: 0o700});
    const directory = await mkdtemp(join(tempRoot, 'turn-'));
    const messagePath = join(directory, 'message.txt');
    try {
      await writeFile(messagePath, voicePrompt(text), {encoding: 'utf8', mode: 0o600});
      const {stdout} = await execute(command, [
        'agent',
        '--agent', 'liv',
        '--session-key', sessionKey,
        '--message-file', messagePath,
        '--json',
        '--timeout', String(Math.ceil(timeoutMs / 1000)),
      ], {
        encoding: 'utf8',
        maxBuffer: 12 * 1024 * 1024,
        timeout: timeoutMs + 5_000,
      });
      return extractResult(stdout);
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  };
}

export function createHandler({token, runTurn}) {
  let serial = Promise.resolve();
  return async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health') {
        return responseJson(response, 200, {ok: true, agent: 'liv'});
      }
      if (request.method !== 'POST' || request.url !== '/turn') {
        return responseJson(response, 404, {error: 'not_found'});
      }
      if (!authorized(request.headers.authorization, token)) {
        return responseJson(response, 401, {error: 'unauthorized'});
      }
      const body = await readJson(request);
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      if (!text || text.length > MAX_TEXT_CHARS) {
        return responseJson(response, 400, {error: 'invalid_text'});
      }
      const turn = serial.then(() => runTurn(text));
      serial = turn.catch(() => {});
      return responseJson(response, 200, await turn);
    } catch (error) {
      const status = error.status ?? 503;
      return responseJson(response, status, {error: status === 503 ? 'voice_agent_unavailable' : error.message});
    }
  };
}

export function startServer(options = {}) {
  const token = options.token ?? process.env.VOICE_AGENT_TOKEN;
  if (!token) throw new Error('VOICE_AGENT_TOKEN is required');
  const runTurn = options.runTurn ?? openClawTurn(options);
  const server = http.createServer({requestTimeout: 190_000}, createHandler({token, runTurn}));
  const port = options.port ?? Number(process.env.VOICE_AGENT_PORT ?? 8796);
  server.listen(port, '127.0.0.1');
  return server;
}

export function isMainModule(moduleUrl, argvPath) {
  return Boolean(argvPath) && moduleUrl === pathToFileURL(realpathSync(argvPath)).href;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.umask(0o077);
  startServer();
}
