import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {audioHandler, captureHandler, parseForm} from './server.mjs';
import {M4A, captureForm, fixture} from './fixture.mjs';

async function serve(handler, run) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await run(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test('capture listener accepts multipart once, reports duplicates, and rejects everything else', async () => {
  const {intake} = fixture();
  await serve(captureHandler(intake, {maxBytes: 4096, log: () => {}}), async (base) => {
    const first = await fetch(`${base}/capture`, {method: 'POST', body: captureForm()});
    assert.equal(first.status, 202);
    const body = await first.json();
    assert.deepEqual([body.status, body.message], ['accepted', 'Sent ✓ — check #inbox']);
    assert.equal(first.headers.get('cache-control'), 'no-store');
    const again = await fetch(`${base}/capture`, {method: 'POST', body: captureForm()});
    assert.deepEqual([again.status, (await again.json()).message], [200, 'Already sent ✓ — check #inbox']);
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

// The framing Shortcuts' HTTP layer (JXHTTPMultipartBody in ActionKit) writes:
// `multipart/form-data; charset=utf-8; boundary=JXHTTP-<guid>-<time>`, a
// text/plain part per field, and a file part with the file's own name and type.
const BOUNDARY = 'JXHTTP-6B0D1D3E-4C5A-4F7B-9E21-0A1B2C3D4E5F-12345-00001A2B3C4D5E6F-1793650000';
function shortcutsBody({eol = '\r\n', close = true, filename = 'filename="Recording 6 Nov 2026 at 11.03 AM.m4a"', audio = M4A} = {}) {
  const part = (name, body, headers) => Buffer.concat([Buffer.from(`--${BOUNDARY}${eol}Content-Disposition: form-data; name="${name}"${headers}${eol}${eol}`), Buffer.from(body), Buffer.from(eol)]);
  const text = `${eol}Content-Type: text/plain; charset=utf-8`;
  return Buffer.concat([part('audio', audio, `; ${filename}${eol}Content-Type: audio/x-m4a`), part('deviceName', 'Ariel’s MacBook Pro', text),
    part('deviceModel', 'MacBook Pro', text), part('capturedAt', '2026-11-06T11:03:12-05:00', text), Buffer.from(close ? `--${BOUNDARY}--${eol}` : '')]);
}
const SHORTCUTS_TYPE = `multipart/form-data; charset=utf-8; boundary=${BOUNDARY}`;

test('form parser reads Shortcuts multipart and tolerates framing variants', async () => {
  const variants = [
    [shortcutsBody(), SHORTCUTS_TYPE],
    [shortcutsBody(), `Multipart/Form-Data; boundary="${BOUNDARY}"`],
    [shortcutsBody({eol: '\n'}), SHORTCUTS_TYPE],
    [shortcutsBody({close: false}), SHORTCUTS_TYPE],
    [shortcutsBody({filename: "filename*=UTF-8''Ariel%E2%80%99s%20memo.m4a"}), SHORTCUTS_TYPE],
    [shortcutsBody(), 'application/octet-stream'],
    [shortcutsBody(), 'multipart/form-data'],
  ];
  for (const [body, type] of variants) {
    const form = parseForm(body, type);
    const audio = form.get('audio');
    assert.ok(audio instanceof File, type);
    assert.deepEqual(Buffer.from(await audio.arrayBuffer()), M4A, type);
    assert.deepEqual([form.get('deviceName'), form.get('deviceModel'), form.get('capturedAt')], ['Ariel’s MacBook Pro', 'MacBook Pro', '2026-11-06T11:03:12-05:00'], type);
  }
  assert.equal(parseForm(shortcutsBody({filename: "filename*=UTF-8''Ariel%E2%80%99s%20memo.m4a"}), SHORTCUTS_TYPE).get('audio').name, 'Ariel’s memo.m4a');
  const urlencoded = parseForm(Buffer.from('text=Call%20Mom&deviceName=Ariel%E2%80%99s+Mac&capturedAt=2026-11-06T11%3A03%3A12-05%3A00'), 'application/x-www-form-urlencoded; charset=utf-8');
  assert.deepEqual([urlencoded.get('text'), urlencoded.get('deviceName')], ['Call Mom', 'Ariel’s Mac']);
  assert.throws(() => parseForm(Buffer.from('{}'), 'application/json'), {status: 415, message: 'form_required'});
  assert.throws(() => parseForm(Buffer.from('no boundary here'), 'multipart/form-data; boundary=abc'), {status: 400, message: 'invalid_form'});
});

test('capture listener accepts Shortcuts uploads, explains each rejection, and logs it without secrets', async () => {
  const {intake} = fixture();
  const logs = [];
  await serve(captureHandler(intake, {maxBytes: 4096, log: (entry) => logs.push(entry)}), async (base) => {
    const post = async (body, type, headers = {}) => {
      const response = await fetch(`${base}/capture`, {method: 'POST', body, headers: {'content-type': type, 'cf-access-client-id': 'id.access', 'cf-access-client-secret': 'shh-secret', ...headers}});
      return [response.status, (await response.json()).message];
    };
    assert.deepEqual(await post(shortcutsBody(), SHORTCUTS_TYPE), [202, 'Sent ✓ — check #inbox']);
    assert.equal(logs.length, 0, 'accepted captures are not rejections');
    assert.deepEqual(await post(Buffer.from('text=Call%20Mom&deviceName=Mac&deviceModel=Mac&capturedAt=2026-11-06T11%3A03%3A12-05%3A00'), 'application/x-www-form-urlencoded'), [202, 'Sent ✓ — check #inbox']);
    assert.deepEqual(await post(shortcutsBody({audio: ''}), SHORTCUTS_TYPE), [400, 'Recording was empty']);
    assert.deepEqual(await post(Buffer.from('audio=Recorded%20Audio&deviceName=Mac&deviceModel=Mac&capturedAt=2026-11-06T11%3A03%3A12-05%3A00'), 'application/x-www-form-urlencoded'), [400, 'Not sent: recording was not attached']);
    assert.deepEqual(await post(shortcutsBody({audio: 'plain text pretending'}), SHORTCUTS_TYPE), [415, 'Not sent: recording format not supported']);
    assert.deepEqual(await post('{}', 'application/json'), [415, 'Not sent: upload unreadable']);
    intake.guard = async () => 'silent_audio';
    assert.deepEqual(await post(shortcutsBody(), SHORTCUTS_TYPE), [400, 'Recording was silent: check the Mac\'s input device in System Settings → Sound']);
    intake.guard = async () => 'too_short';
    assert.deepEqual(await post(shortcutsBody(), SHORTCUTS_TYPE), [400, 'Recording was too short']);
    intake.guard = undefined;
    assert.deepEqual(logs.map(entry => [entry.status, entry.reason]), [[400, 'empty_audio'], [400, 'audio_not_file'], [415, 'unsupported_audio'], [415, 'form_required'], [400, 'silent_audio'], [400, 'too_short']]);
    for (const entry of logs) {
      assert.match(entry.requestId, /^[0-9a-f-]{36}$/);
      assert.ok(entry.contentType && entry.contentLength, 'framing is logged');
      const line = JSON.stringify(entry);
      for (const leak of ['shh-secret', 'id.access', 'Recorded Audio', 'ftyp', 'plain text']) assert.ok(!line.includes(leak), leak);
    }
    await intake.serial;
  });
  const broken = fixture();
  broken.intake.accept = async () => { throw new Error('disk full'); };
  const brokenLogs = [];
  await serve(captureHandler(broken.intake, {log: (entry) => brokenLogs.push(entry)}), async (base) => {
    const response = await fetch(`${base}/capture`, {method: 'POST', body: shortcutsBody(), headers: {'content-type': SHORTCUTS_TYPE}});
    assert.deepEqual([response.status, (await response.json()).message], [503, 'Mini unavailable: try again soon']);
    assert.deepEqual([brokenLogs[0].reason, brokenLogs[0].detail], ['unavailable', 'disk full']);
  });
});
