import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {createHandler, isMainModule, openClawTurn} from './server.mjs';

function request(method, url, body, authorization = 'Bearer test-token') {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method,
    url,
    headers: {authorization},
    async *[Symbol.asyncIterator]() { yield* chunks; },
  };
}

function response() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
    json() { return JSON.parse(this.body); },
  };
}

test('health identifies Liv without requiring a credential', async () => {
  const output = response();
  await createHandler({token: 'test-token', runTurn: async () => ({})})(request('GET', '/health'), output);
  assert.equal(output.status, 200);
  assert.deepEqual(output.json(), {ok: true, agent: 'liv'});
  assert.equal(output.headers['cache-control'], 'no-store');
});

test('turn requires the exact bearer credential', async () => {
  const output = response();
  await createHandler({token: 'test-token', runTurn: async () => ({})})(request('POST', '/turn', {text: 'hello'}, 'Bearer wrong'), output);
  assert.equal(output.status, 401);
  assert.deepEqual(output.json(), {error: 'unauthorized'});
});

test('turn validates text and returns only the bounded result', async () => {
  const output = response();
  await createHandler({
    token: 'test-token',
    runTurn: async (text) => ({reply: `heard ${text}`, runId: 'run-1', durationMs: 12}),
  })(request('POST', '/turn', {text: 'open threads'}), output);
  assert.equal(output.status, 200);
  assert.deepEqual(output.json(), {reply: 'heard open threads', runId: 'run-1', durationMs: 12});
});

test('turns are serialized for the shared Liv voice session', async () => {
  let active = 0;
  let peak = 0;
  const handler = createHandler({
    token: 'test-token',
    runTurn: async (text) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return {reply: text};
    },
  });
  const first = response();
  const second = response();
  await Promise.all([
    handler(request('POST', '/turn', {text: 'first'}), first),
    handler(request('POST', '/turn', {text: 'second'}), second),
  ]);
  assert.equal(peak, 1);
  assert.equal(first.json().reply, 'first');
  assert.equal(second.json().reply, 'second');
});

test('OpenClaw runner uses a private message file, fixed Liv agent, and removes the file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voice-agent-test-'));
  let observed;
  try {
    const run = openClawTurn({
      command: '/example/openclaw',
      sessionKey: 'agent:liv:test-voice',
      tempRoot: root,
      execute: async (command, args) => {
        const messagePath = args[args.indexOf('--message-file') + 1];
        observed = {command, args, messagePath, prompt: await readFile(messagePath, 'utf8')};
        return {stdout: JSON.stringify({
          runId: 'run-2',
          status: 'ok',
          result: {payloads: [{text: 'done'}], meta: {durationMs: 42}},
        })};
      },
    });
    assert.deepEqual(await run('reply in Slack'), {reply: 'done', runId: 'run-2', durationMs: 42});
    assert.equal(observed.command, '/example/openclaw');
    assert.deepEqual(observed.args.slice(0, 5), ['agent', '--agent', 'liv', '--session-key', 'agent:liv:test-voice']);
    assert.match(observed.prompt, /Authenticated Ariel voice interface/);
    assert.match(observed.prompt, /slack_workspace tool/);
    assert.match(observed.prompt, /reply in Slack/);
    await assert.rejects(readFile(observed.messagePath, 'utf8'));
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('main module detection handles runtime symlinks and spaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'voice agent main-'));
  try {
    const target = join(root, 'server.mjs');
    const link = join(root, 'current-server.mjs');
    await writeFile(target, '');
    await symlink(target, link);
    const moduleUrl = pathToFileURL(realpathSync(target)).href;
    assert.equal(isMainModule(moduleUrl, target), true);
    assert.equal(isMainModule(moduleUrl, link), true);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});
