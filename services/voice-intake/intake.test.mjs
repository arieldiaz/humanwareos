import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {M4A, NOW, captureForm, fixture} from './fixture.mjs';
import {FFMPEG, SlackPoster, audioGuard, audioRejection, audioType, deviceEmoji, gist, normalizeCapture, parseVolumeDetect, rootText, transcriptText, trivialTranscript} from './intake.mjs';

// CI runners carry ffmpeg at /usr/bin; the instance pins the Homebrew path.
const ffmpeg = [process.env.FFMPEG, FFMPEG, '/usr/bin/ffmpeg'].find(path => path && existsSync(path));
const clip = (dir, name, source, seconds) => {
  const path = join(dir, name);
  execFileSync(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', source, '-t', String(seconds), ...(name.endsWith('.m4a') ? ['-c:a', 'aac'] : []), path]);
  return readFileSync(path);
};

test('audio type is read from bytes, not the file name', () => {
  assert.equal(audioType(M4A).ext, 'm4a');
  assert.equal(audioType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')])).ext, 'wav');
  assert.equal(audioType(Buffer.from('<html>not audio</html>')), null);
});

test('capture validation rejects malformed forms', async () => {
  const opts = {maxBytes: 1024, now: NOW};
  await assert.rejects(normalizeCapture(captureForm({deviceName: ''}), opts), /invalid_device_name/);
  await assert.rejects(normalizeCapture(captureForm({capturedAt: 'yesterday'}), opts), /invalid_captured_at/);
  await assert.rejects(normalizeCapture(captureForm({capturedAt: '2026-11-07T12:00:00Z'}), opts), /invalid_captured_at/);
  await assert.rejects(normalizeCapture(captureForm({audio: Buffer.from('not audio at all')}), opts), {status: 415});
  await assert.rejects(normalizeCapture(captureForm({audio: Buffer.alloc(2048, 1)}), opts), {status: 413});
  await assert.rejects(normalizeCapture(captureForm({text: 'both'}), opts), /audio_or_text_required/);
  await assert.rejects(normalizeCapture(captureForm({audio: null}), opts), /audio_or_text_required/);
  const capture = await normalizeCapture(captureForm(), opts);
  assert.equal(capture.capturedAt, '2026-11-06T16:03:12.000Z');
  assert.match(capture.id, /^[0-9a-f]{32}$/);
});

test('volumedetect output is parsed and judged; unmeasured fields never reject', () => {
  const report = '  Duration: 00:00:05.90, start: 0.000000, bitrate: 2 kb/s\n[Parsed_volumedetect_0 @ 0x1] mean_volume: -91.0 dB\n[Parsed_volumedetect_0 @ 0x1] max_volume: -91.0 dB\n';
  assert.deepEqual(parseVolumeDetect(report), {maxVolume: -91, duration: 5.9});
  assert.deepEqual(parseVolumeDetect('max_volume: -inf dB'), {maxVolume: -Infinity, duration: null});
  assert.deepEqual(parseVolumeDetect('garbage'), {maxVolume: null, duration: null});
  assert.equal(audioRejection({maxVolume: -91, duration: 5.9}), 'silent_audio');
  assert.equal(audioRejection({maxVolume: -Infinity, duration: 5.9}), 'silent_audio');
  assert.equal(audioRejection({maxVolume: -18.1, duration: 0.2}), 'too_short');
  assert.equal(audioRejection({maxVolume: -91, duration: 0.2}), 'too_short');
  assert.equal(audioRejection({maxVolume: -18.1, duration: 5.9}), null);
  assert.equal(audioRejection({maxVolume: -49.9, duration: 1}), null);
  assert.equal(audioRejection({maxVolume: null, duration: null}), null);
  assert.equal(audioRejection({maxVolume: -60, duration: 1}, {minDb: -70}), null);
});

test('the audio guard rejects silent and too-short clips, keeps speech, and skips when ffmpeg fails', {skip: !ffmpeg && 'ffmpeg not installed'}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-intake-clips-'));
  try {
    const silence = clip(dir, 'silence.m4a', 'anullsrc=r=44100:cl=mono', 2);
    const tone = clip(dir, 'tone.wav', 'sine=frequency=440:sample_rate=16000', 2);
    const short = clip(dir, 'short.wav', 'sine=frequency=440:sample_rate=16000', 0.2);
    assert.equal(audioType(silence).ext, 'm4a');
    const guard = audioGuard({ffmpeg});
    assert.equal(await guard(silence, 'm4a'), 'silent_audio');
    assert.equal(await guard(tone, 'wav'), null);
    assert.equal(await guard(short, 'wav'), 'too_short');
    const opts = {maxBytes: 1024 * 1024, now: NOW, guard};
    await assert.rejects(normalizeCapture(captureForm({audio: silence}), opts), {status: 400, message: 'silent_audio'});
    await assert.rejects(normalizeCapture(captureForm({audio: short}), opts), {status: 400, message: 'too_short'});
    assert.equal((await normalizeCapture(captureForm({audio: tone}), opts)).ext, 'wav');
    const {intake} = fixture({guard});
    await assert.rejects(intake.accept(captureForm({audio: silence})), /silent_audio/);
    assert.equal(intake.store.open().length, 0, 'silence is never stored');
    const logs = [];
    const broken = audioGuard({ffmpeg: join(dir, 'missing-ffmpeg'), log: (entry) => logs.push(entry)});
    assert.equal(await broken(silence, 'm4a'), null, 'a broken ffmpeg never blocks intake');
    assert.deepEqual([logs.length, logs[0].event, logs[0].detail], [1, 'audio_guard_skipped', 'ENOENT']);
    assert.equal(await audioGuard({ffmpeg})(M4A, 'm4a'), null, 'an undecodable clip is skipped, not rejected');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a retried upload is the same capture and evidence is written once, private', async () => {
  const {intake} = fixture();
  const first = await intake.accept(captureForm());
  const again = await intake.accept(captureForm());
  assert.deepEqual([first.status, again.status], ['accepted', 'duplicate']);
  assert.equal(first.captureId, again.captureId);
  const row = intake.store.get(first.captureId);
  assert.match(row.evidence_path, /evidence\/2026\/11\/[0-9a-f]{32}\.m4a$/);
  assert.deepEqual(readFileSync(row.evidence_path), M4A);
  assert.equal(statSync(row.evidence_path).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(row.evidence_path.replace(/m4a$/, 'json'))).sha256, row.sha256);
  const other = await intake.accept(captureForm({capturedAt: '2026-11-06T11:04:00-05:00'}));
  assert.notEqual(other.captureId, first.captureId);
});

test('pipeline posts root and transcript as threaded replies, then admits one Liv turn', async () => {
  const {intake, posts, calls} = fixture();
  const {captureId} = await intake.accept(captureForm());
  await intake.drain();
  const row = intake.store.get(captureId);
  assert.equal(row.state, 'dispatched');
  assert.equal(posts[0].part, 'root');
  assert.equal(posts[0].threadTs, undefined);
  assert.equal(posts[0].text, '📱 Ariel’s iPhone · Fri, Nov 6, 11:03 AM · Book vet for Pepe');
  assert.equal(posts[1].part, 'transcript');
  assert.equal(posts[1].threadTs, '1793.1');
  assert.match(posts[1].text, /^Remind me to book the vet/);
  assert.ok(posts[1].text.includes(`<https://os.example.test/voice-intake/audio/${captureId}|🎧 Original audio>`));
  assert.equal(calls.length, 1);
  const [method, params] = calls[0];
  assert.equal(method, 'agent');
  assert.equal(params.sessionKey, 'agent:liv:slack:channel:c0inbox:thread:1793.1');
  assert.equal(params.idempotencyKey, `voice-intake:${captureId}`);
  assert.equal(params.deliver, true);
  assert.equal(params.threadId, '1793.1');
  assert.ok(!params.message.includes('Pepe'), 'transcript stays out of argv');
  const requestPath = /request record at (\S+)\./.exec(params.message)[1];
  assert.equal(JSON.parse(readFileSync(requestPath)).transcript, 'Remind me to book the vet for Pepe next week.');
  await intake.drain();
  assert.equal(calls.length, 1, 'a dispatched capture is never re-admitted');
});

test('dictation captures skip transcription and have no audio link', async () => {
  const {intake, posts} = fixture({transcribe: async () => { throw new Error('must not run'); }});
  const {captureId} = await intake.accept(captureForm({audio: null, text: 'Add oat milk to the list', deviceModel: 'Apple Watch', deviceName: 'Watch'}));
  await intake.drain();
  assert.equal(intake.store.get(captureId).state, 'dispatched');
  assert.match(posts[0].text, /^⌚ Watch · /);
  assert.match(posts[1].text, /no audio was recorded/);
});

test('a trivial or hallucinated transcript becomes its own title without asking the summarizer', async () => {
  for (const hallucination of ['Thank you.', 'Thanks for watching!', 'you', 'Thank you for watching.', 'Bye.', '']) assert.equal(trivialTranscript(hallucination), true, hallucination);
  assert.equal(trivialTranscript('Call the vet tomorrow'), false);
  assert.equal(trivialTranscript('Thank you for the vet referral'), false);
  let asked = 0;
  const {intake, posts} = fixture({transcribe: async () => 'Thank you.'});
  intake.summarize = async () => { asked++; return 'Please provide the voice note!'; };
  const {captureId} = await intake.accept(captureForm());
  await intake.drain();
  assert.equal(asked, 0);
  assert.equal(intake.store.get(captureId).summary, 'Thank you.');
  assert.match(posts[0].text, / · Thank you\.$/);
});

test('transient failures retry, then hold with a bounded reason', async () => {
  let failures = 0;
  const {intake} = fixture({transcribe: async () => { failures++; throw new Error('whisper crashed'); }});
  const {captureId} = await intake.accept(captureForm());
  for (let i = 0; i < 6; i++) await intake.drain();
  const row = intake.store.get(captureId);
  assert.deepEqual([row.state, row.reason, failures], ['held', 'received_failed', 5]);
  assert.equal(intake.store.health().held, 1);
});

test('unconfirmed admission holds; an interrupted admission reconciles from the run', async () => {
  const unconfirmed = fixture({gateway: async () => { throw new Error('timeout'); }});
  const a = await unconfirmed.intake.accept(captureForm());
  await unconfirmed.intake.drain();
  assert.deepEqual([unconfirmed.intake.store.get(a.captureId).state, unconfirmed.intake.store.get(a.captureId).reason], ['held', 'admission_unconfirmed']);

  const waits = [];
  const restarted = fixture({gateway: async (method, params) => { waits.push(method); return {runId: params.runId, status: 'ok'}; }});
  const b = await restarted.intake.accept(captureForm());
  restarted.intake.store.update(b.captureId, {state: 'dispatching', run_id: `voice-intake:${b.captureId}`, channel_id: 'C0INBOX', root_ts: '1.1'});
  await restarted.intake.drain();
  assert.equal(restarted.intake.store.get(b.captureId).state, 'dispatched');
  assert.deepEqual(waits, ['agent.wait']);
});

test('Slack poster reconciles a lost post by metadata and refuses to post unverified', async () => {
  const sent = [];
  const call = async (method, token, args) => {
    if (method === 'auth.test') return {user_id: 'ULIV'};
    if (method === 'conversations.info') return {channel: {name: 'inbox', is_member: true}};
    if (method === 'conversations.history') return {messages: [{user: 'ULIV', ts: '9.9', metadata: {event_type: 'voice_intake', event_payload: {marker: 'abc:root'}}}]};
    if (method === 'conversations.replies') return {messages: []};
    sent.push(args); return {ok: true, channel: 'C0INBOX', ts: '9.10'};
  };
  const poster = new SlackPoster({channel: {channelId: 'C0INBOX', name: 'inbox'}, token: 'x', call});
  await assert.rejects(poster.post({captureId: 'abc', part: 'root', since: NOW.toISOString(), text: 'x'}), /slack_unverified/);
  await poster.verify();
  assert.deepEqual(await poster.post({captureId: 'abc', part: 'root', since: NOW.toISOString(), text: 'x'}), {channelId: 'C0INBOX', ts: '9.9'});
  assert.equal(sent.length, 0);
  await poster.post({captureId: 'abc', part: 'transcript', since: NOW.toISOString(), threadTs: '9.9', text: 'y'});
  assert.equal(sent[0].thread_ts, '9.9');
  assert.deepEqual(JSON.parse(sent[0].metadata), {event_type: 'voice_intake', event_payload: {marker: 'abc:transcript'}});
});

test('rendering escapes Slack markup and picks a device emoji', () => {
  assert.deepEqual(['iPhone', 'Apple Watch', 'Mac', 'iPad', 'Vision'].map(deviceEmoji), ['📱', '⌚', '💻', '📱', '🎙️']);
  assert.equal(gist('one two three four five six seven eight nine ten eleven'), 'one two three four five six seven eight nine ten…');
  const row = {device_model: 'Mac', device_name: '<!channel>', captured_at: '2026-07-01T12:00:00Z', summary: 'a & b', kind: 'audio', transcript: '<@U1> hi'};
  assert.equal(rootText(row, 'America/New_York'), '💻 &lt;!channel&gt; · Wed, Jul 1, 8:00 AM · a &amp; b');
  assert.match(transcriptText(row, 'https://x/a'), /^&lt;@U1&gt; hi\n\n<https:\/\/x\/a\|/);
  assert.ok(transcriptText({...row, transcript: 'w '.repeat(30000)}, 'https://x/a').length < 40000);
});
