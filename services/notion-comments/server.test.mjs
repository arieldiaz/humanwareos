import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import http from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import {VerificationToken, handler, isMainModule} from './server.mjs';
import {validSignature} from './notion.mjs';
import {Store} from './store.mjs';

const TOKEN = 'secret_test_verification_token';
const sign = (body, token = TOKEN) => `sha256=${createHmac('sha256', token).update(body).digest('hex')}`;

async function serve(t, {secret = null} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'notion-comments-server-'));
  const store = new Store(join(directory, 'comments.sqlite3'));
  const token = new VerificationToken({path: join(directory, 'verification-token'), secret});
  const received = [];
  const channel = {receive: event => { received.push(event); return store.receive(event.entity.id, event.id); }, drain: () => {}};
  const server = http.createServer(handler({channel, store, token}));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); store.close(); rmSync(directory, {recursive: true, force: true}); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}) => fetch(`${url}/webhook/notion`, {method: 'POST', body, headers: {'content-type': 'application/json', ...headers}});
  return {url, post, token, received, directory};
}

test('signature check uses the raw body and a constant-length comparison', () => {
  const body = Buffer.from('{"a": 1}');
  assert.equal(validSignature(body, sign(body), TOKEN), true);
  assert.equal(validSignature(Buffer.from('{"a":1}'), sign(body), TOKEN), false);
  assert.equal(validSignature(body, sign(body, 'other'), TOKEN), false);
  assert.equal(validSignature(body, 'sha256=short', TOKEN), false);
  assert.equal(validSignature(body, undefined, TOKEN), false);
});

test('captures the first verification token privately and never echoes or replaces it', async t => {
  const s = await serve(t);
  const event = JSON.stringify({id: 'e1', type: 'comment.created', entity: {id: 'c1', type: 'comment'}});
  assert.equal((await s.post(event, {'x-notion-signature': sign(event)})).status, 503);
  const first = await s.post(JSON.stringify({verification_token: TOKEN}));
  const text = await first.text();
  assert.deepEqual(JSON.parse(text), {captured: true});
  assert.equal(text.includes(TOKEN), false);
  const path = join(s.directory, 'verification-token');
  assert.equal(readFileSync(path, 'utf8'), TOKEN);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(await (await s.post(JSON.stringify({verification_token: 'secret_attacker'}))).json(), {captured: false});
  assert.equal(readFileSync(path, 'utf8'), TOKEN);
});

test('accepts only signed events and records each comment once', async t => {
  const s = await serve(t, {secret: TOKEN});
  const event = JSON.stringify({id: 'e1', type: 'comment.created', entity: {id: 'c1', type: 'comment'}, data: {page_id: 'p1'}});
  assert.equal((await s.post(event)).status, 401);
  assert.equal((await s.post(event, {'x-notion-signature': sign(event, 'wrong')})).status, 401);
  assert.deepEqual(await (await s.post(event, {'x-notion-signature': sign(event)})).json(), {accepted: true});
  assert.deepEqual(await (await s.post(event, {'x-notion-signature': sign(event)})).json(), {accepted: false});
  // A configured secret wins over any handshake body.
  assert.deepEqual(await (await s.post(JSON.stringify({verification_token: 'secret_other'}))).json(), {captured: false});
  const health = await fetch(`${s.url}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {sqlite: true, pending: 1, held: 0, verified: true, ok: true});
  assert.equal((await fetch(`${s.url}/other`)).status, 404);
});

test('recognizes a main module invoked through a runtime symlink', () => {
  const directory = mkdtempSync(join(tmpdir(), 'notion-comments-main-'));
  try {
    const target = join(directory, 'server.mjs');
    const link = join(directory, 'current-server.mjs');
    writeFileSync(target, '');
    symlinkSync(target, link);
    assert.equal(isMainModule(pathToFileURL(realpathSync(target)).href, link), true);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
