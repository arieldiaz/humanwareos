import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {audioHandler, captureHandler} from './server.mjs';
import {captureForm, fixture} from './fixture.mjs';

async function serve(handler, run) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await run(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test('capture listener accepts multipart once, reports duplicates, and rejects everything else', async () => {
  const {intake} = fixture();
  await serve(captureHandler(intake, {maxBytes: 4096}), async (base) => {
    const first = await fetch(`${base}/capture`, {method: 'POST', body: captureForm()});
    assert.equal(first.status, 202);
    const body = await first.json();
    assert.deepEqual([body.status, body.message], ['accepted', 'Sent to Liv']);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    const again = await fetch(`${base}/capture`, {method: 'POST', body: captureForm()});
    assert.deepEqual([again.status, (await again.json()).status], [200, 'duplicate']);
    assert.equal((await fetch(`${base}/capture`, {method: 'POST', body: '{}', headers: {'content-type': 'application/json'}})).status, 415);
    assert.equal((await fetch(`${base}/capture`, {method: 'POST', body: captureForm({audio: Buffer.from('plain text pretending')})})).status, 415);
    assert.equal((await fetch(`${base}/capture`, {method: 'POST', body: captureForm({audio: Buffer.alloc(80 * 1024, 1)})})).status, 413);
    assert.equal((await fetch(`${base}/audio/${body.captureId}`)).status, 404, 'audio is never served on the capture listener');
    assert.equal((await fetch(`${base}/capture`)).status, 404);
    await intake.serial;
  });
});

test('audio listener serves stored audio by id with byte ranges, and nothing else', async () => {
  const {intake} = fixture();
  const {captureId} = await intake.accept(captureForm());
  const dictated = await intake.accept(captureForm({audio: null, text: 'hello'}));
  await serve(audioHandler(intake), async (base) => {
    const full = await fetch(`${base}/audio/${captureId}`);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'audio/mp4');
    assert.equal(full.headers.get('referrer-policy'), 'no-referrer');
    assert.equal((await full.arrayBuffer()).byteLength, 76);
    const part = await fetch(`${base}/audio/${captureId}`, {headers: {range: 'bytes=4-11'}});
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), 'bytes 4-11/76');
    assert.equal(Buffer.from(await part.arrayBuffer()).toString('latin1'), 'ftypM4A ');
    assert.equal((await fetch(`${base}/audio/${captureId}`, {headers: {range: 'bytes=100-'}})).status, 416);
    assert.equal((await fetch(`${base}/audio/${dictated.captureId}`)).status, 404);
    assert.equal((await fetch(`${base}/audio/../../etc/passwd`)).status, 404);
    assert.equal((await fetch(`${base}/capture`, {method: 'POST', body: captureForm()})).status, 404, 'capture is never accepted on the audio listener');
  });
});
