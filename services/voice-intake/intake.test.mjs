import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BROOKLYN, M4A, NOW, captureForm, fixture} from './fixture.mjs';
import {FFMPEG, SlackPoster, Store, audioGuard, audioRejection, audioType, deviceEmoji, gist, normalizeCapture, normalizeLocation, parseVolumeDetect, rootText, sentMessage, shortcutVersion, transcriptText, trivialTranscript} from './intake.mjs';
import {SHORTCUT_VERSION} from './shortcut.mjs';
import {DatabaseSync} from 'node:sqlite';

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

test('location is optional, never rejects, and keeps coordinates out of the label', async () => {
  const form = (location) => captureForm({location});
  assert.deepEqual(normalizeLocation(form(BROOKLYN)), {latitude: 40.678178, longitude: -73.944158, locationLabel: 'Brooklyn, NY'});
  assert.deepEqual(normalizeLocation(form({})), {latitude: null, longitude: null, locationLabel: null});
  assert.deepEqual(normalizeLocation(form({latitude: '', longitude: '', locationCity: '', locationState: '', locationName: ''})), {latitude: null, longitude: null, locationLabel: null});
  assert.deepEqual(normalizeLocation(form({latitude: '0', longitude: '0'})), {latitude: 0, longitude: 0, locationLabel: null});
  assert.deepEqual(normalizeLocation(form({latitude: 'abc', longitude: '-73.9', locationCity: 'Brooklyn'})), {latitude: null, longitude: null, locationLabel: 'Brooklyn'});
  assert.deepEqual(normalizeLocation(form({latitude: '91', longitude: '-73.9', locationState: 'NY'})).locationLabel, 'NY');
  assert.equal(normalizeLocation(form({locationName: 'Prospect\tPark'})).locationLabel, 'Prospect Park');
  assert.equal(normalizeLocation(form({locationName: 'x'.repeat(200)})).locationLabel.length, 100);
  const opts = {maxBytes: 1024, now: NOW};
  const [plain, located] = await Promise.all([normalizeCapture(captureForm(), opts), normalizeCapture(form(BROOKLYN), opts)]);
  assert.equal(plain.id, located.id, 'location never changes the capture id');
  assert.equal(plain.latitude, null);
});

test('a located capture records coordinates in evidence and ledger, and only the label reaches the root post', async () => {
  const {intake, posts, updates, calls} = fixture();
  const {captureId} = await intake.accept(captureForm({location: BROOKLYN}));
  await intake.drain();
  await intake.idle();
  const row = intake.store.get(captureId);
  assert.deepEqual([row.latitude, row.longitude, row.location_label], [40.678178, -73.944158, 'Brooklyn, NY']);
  assert.deepEqual(JSON.parse(readFileSync(row.evidence_path.replace(/m4a$/, 'json'))).location, {latitude: 40.678178, longitude: -73.944158, label: 'Brooklyn, NY'});
  assert.equal(posts[0].text, '📱 · Fri, Nov 6, 11:03 AM · Brooklyn, NY · Remind me to book the vet for Pepe next week.', 'the root posts at once with the first words');
  assert.equal(updates.at(-1).text, '📱 · Fri, Nov 6, 11:03 AM · Brooklyn, NY · Book vet for Pepe', 'the summarizer retitles the root in place, label intact');
  for (const post of [...posts, ...updates]) assert.ok(!post.text.includes('40.67') && !post.text.includes('73.94'), 'coordinates stay off Slack');
  const requestPath = /request record at (\S+)\./.exec(calls[0][1].message)[1];
  assert.deepEqual(JSON.parse(readFileSync(requestPath)).location, {latitude: 40.678178, longitude: -73.944158, label: 'Brooklyn, NY'});
  const bare = fixture();
  const bareId = (await bare.intake.accept(captureForm())).captureId;
  assert.equal(JSON.parse(readFileSync(bare.intake.store.get(bareId).evidence_path.replace(/m4a$/, 'json'))).location, null);
});

test('the shortcut version is recorded, never rejects, and only an outdated one is mentioned', async () => {
  const opts = {maxBytes: 1024, now: NOW};
  assert.equal(SHORTCUT_VERSION, 4);
  for (const [sent, expected] of [['4', 4], [' 7 ', 7], ['3', 3], ['', null], ['abc', null], ['0', null], ['4.5', null], [null, null]]) assert.equal(shortcutVersion(captureForm({shortcutVersion: sent})), expected, String(sent));
  const [current, old, plain] = await Promise.all([normalizeCapture(captureForm(), opts), normalizeCapture(captureForm({shortcutVersion: '3'}), opts), normalizeCapture(captureForm({shortcutVersion: null}), opts)]);
  assert.deepEqual([current.shortcutVersion, old.shortcutVersion, plain.shortcutVersion], [4, 3, null]);
  assert.equal(current.id, old.id, 'the version never changes the capture id');
  assert.equal(sentMessage({status: 'accepted', shortcutVersion: 4}), 'Sent ✓ · v4');
  assert.equal(sentMessage({status: 'duplicate', shortcutVersion: 5}), 'Already sent ✓ · v5', 'a newer shortcut than the service knows is not outdated');
  assert.equal(sentMessage({status: 'accepted', shortcutVersion: 3}), 'Sent ✓ · shortcut v3 is outdated, v4 is available');
  assert.equal(sentMessage({status: 'duplicate', shortcutVersion: null}), 'Already sent ✓ · shortcut pre-v4 is outdated, v4 is available');
  const {intake, posts} = fixture();
  const accepted = await intake.accept(captureForm({shortcutVersion: '3'}));
  assert.deepEqual([accepted.status, accepted.shortcutVersion], ['accepted', 3]);
  assert.equal((await intake.accept(captureForm())).shortcutVersion, 4, 'a duplicate reports the version of the upload that arrived');
  const row = intake.store.get(accepted.captureId);
  assert.equal(row.shortcut_version, 3);
  assert.equal(JSON.parse(readFileSync(row.evidence_path.replace(/m4a$/, 'json'))).shortcutVersion, 3);
  await intake.drain();
  assert.match(posts[1].text, /🎧 Original audio>\n_Shortcut v3, current is v4_$/, 'the transcript reply names the drift');
  const fresh = fixture();
  await fresh.intake.accept(captureForm());
  await fresh.intake.drain();
  assert.ok(!fresh.posts[1].text.includes('Shortcut'), 'a current shortcut is not mentioned');
  const unversioned = {kind: 'dictation', transcript: 'hi', shortcut_version: null};
  assert.equal(transcriptText(unversioned, 'https://x/a'), 'hi\n\n_Dictated on device; no audio was recorded._\n_Shortcut pre-v4, current is v4_');
});

test('a ledger created before location gains the columns in place', () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-intake-ledger-'));
  try {
    const path = join(dir, 'captures.sqlite3');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE voice_captures (id TEXT PRIMARY KEY, kind TEXT NOT NULL, device_name TEXT NOT NULL, device_model TEXT NOT NULL,
      captured_at TEXT NOT NULL, received_at TEXT NOT NULL, updated_at TEXT NOT NULL, evidence_path TEXT NOT NULL, media_type TEXT NOT NULL,
      bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      transcript TEXT, summary TEXT, channel_id TEXT, root_ts TEXT, transcript_ts TEXT, session_key TEXT, run_id TEXT);
      INSERT INTO voice_captures (id, kind, device_name, device_model, captured_at, received_at, updated_at, evidence_path, media_type, bytes, sha256, state)
      VALUES ('old', 'audio', 'Mac', 'Mac', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', '/x', 'audio/mp4', 1, 'h', 'dispatched');`);
    old.close();
    const store = new Store(path);
    assert.deepEqual([store.get('old').location_label, store.get('old').latitude, store.get('old').shortcut_version], [null, null, null]);
    assert.ok(store.insert({id: 'new', kind: 'audio', deviceName: 'Mac', deviceModel: 'Mac', capturedAt: '2026-11-02T00:00:00Z', mediaType: 'audio/mp4', bytes: Buffer.alloc(1), sha256: 'h2', latitude: 1.5, longitude: 2.5, locationLabel: 'Somewhere', shortcutVersion: 4}, '/y'));
    assert.deepEqual([store.get('new').latitude, store.get('new').location_label, store.get('new').shortcut_version], [1.5, 'Somewhere', 4]);
    store.close();
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
  const {intake, posts, updates, calls, logs} = fixture();
  const {captureId} = await intake.accept(captureForm());
  await intake.drain();
  await intake.idle();
  const row = intake.store.get(captureId);
  assert.equal(row.state, 'dispatched');
  assert.equal(posts[0].part, 'root');
  assert.equal(posts[0].threadTs, undefined);
  assert.equal(posts[0].text, '📱 · Fri, Nov 6, 11:03 AM · Remind me to book the vet for Pepe next week.', 'the root posts with the first words before the summarizer answers');
  assert.deepEqual(updates, [{channelId: 'C0INBOX', ts: '1793.1', text: '📱 · Fri, Nov 6, 11:03 AM · Book vet for Pepe'}], 'the summarizer retitles the root in place');
  assert.equal(row.summary, 'Book vet for Pepe');
  assert.deepEqual(logs.map(entry => entry.event), ['capture_rooted', 'capture_retitled']);
  assert.ok(logs[0].transcribeMs >= 0 && logs[0].rootMs >= 0 && logs[0].sinceReceivedMs >= 0, 'timings are logged for the ledger');
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
  assert.match(posts[0].text, /^⌚ · /);
  assert.match(posts[1].text, /no audio was recorded/);
});

test('a trivial or hallucinated transcript becomes its own title without asking the summarizer', async () => {
  for (const hallucination of ['Thank you.', 'Thanks for watching!', 'you', 'Thank you for watching.', 'Bye.', '']) assert.equal(trivialTranscript(hallucination), true, hallucination);
  assert.equal(trivialTranscript('Call the vet tomorrow'), false);
  assert.equal(trivialTranscript('Thank you for the vet referral'), false);
  let asked = 0;
  const {intake, posts, updates} = fixture({transcribe: async () => 'Thank you.', summarize: async () => { asked++; return 'Please provide the voice note!'; }});
  const {captureId} = await intake.accept(captureForm());
  await intake.drain();
  await intake.idle();
  assert.equal(asked, 0);
  assert.equal(intake.store.get(captureId).summary, 'Thank you.');
  assert.match(posts[0].text, / · Thank you\.$/);
  assert.equal(updates.length, 0);
});

test('the root never waits for the summarizer, and a slow or failing summarizer leaves the first-words title', async () => {
  let release;
  const slow = fixture({summarize: () => new Promise(resolve => { release = resolve; })});
  const {captureId} = await slow.intake.accept(captureForm());
  await slow.intake.drain();
  assert.equal(slow.intake.store.get(captureId).state, 'dispatched', 'transcript reply and admission do not wait for the title');
  assert.equal(slow.updates.length, 0);
  release('Book vet for Pepe');
  await slow.intake.idle();
  assert.equal(slow.updates.length, 1);

  const failing = fixture({summarize: async () => { throw new Error('ollama down'); }});
  const failed = await failing.intake.accept(captureForm());
  await failing.intake.drain();
  await failing.intake.idle();
  assert.equal(failing.updates.length, 0);
  assert.equal(failing.intake.store.get(failed.captureId).summary, 'Remind me to book the vet for Pepe next week.');
  assert.deepEqual(failing.logs.at(-1), {...failing.logs.at(-1), event: 'retitle_failed', detail: 'ollama down'});

  const same = fixture({summarize: async () => 'Remind me to book the vet for Pepe next week.'});
  await same.intake.accept(captureForm());
  await same.intake.drain();
  await same.intake.idle();
  assert.equal(same.updates.length, 0, 'an identical title is not re-sent');
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

test('with a user token the poster posts as the owner, reads with the bot, and drops metadata when Slack refuses it', async () => {
  const sent = [];
  let refuseMetadata = false;
  const call = async (method, token, args) => {
    if (method === 'auth.test') return {user_id: token === 'xoxp-owner' ? 'UARIEL' : 'ULIV'};
    if (method === 'conversations.info') { assert.equal(token, 'xoxb-bot'); return {channel: {name: 'inbox', is_member: true}}; }
    if (method === 'conversations.history') { assert.equal(token, 'xoxb-bot', 'reads never use the user token'); return {messages: [
      {user: 'ULIV', ts: '1.1', text: 'root text'}, {user: 'UARIEL', ts: '1.2', text: 'root text', thread_ts: '1.0'}, {user: 'UARIEL', ts: '1.3', text: 'root text'}]}; }
    if (method === 'conversations.replies') { assert.equal(token, 'xoxb-bot'); return {messages: [{user: 'UARIEL', ts: '1.3', text: 'reply text'}]}; }
    assert.equal(token, 'xoxp-owner', 'posts use the user token');
    if (refuseMetadata && args.metadata) throw new Error('slack chat.postMessage failed: invalid_metadata_format');
    sent.push(args); return {ok: true, channel: 'C0INBOX', ts: `2.${sent.length}`};
  };
  const poster = new SlackPoster({channel: {channelId: 'C0INBOX', name: 'inbox'}, token: 'xoxb-bot', userToken: 'xoxp-owner', call});
  await poster.verify();
  assert.deepEqual([poster.botUserId, poster.posterUserId], ['ULIV', 'UARIEL']);
  // A lost root without metadata is found by the owner's authorship and text, never by the bot's identical message or a threaded reply.
  assert.deepEqual(await poster.post({captureId: 'abc', part: 'root', since: NOW.toISOString(), text: 'root text'}), {channelId: 'C0INBOX', ts: '1.3'});
  assert.equal(sent.length, 0);
  assert.deepEqual(await poster.post({captureId: 'abc', part: 'transcript', since: NOW.toISOString(), threadTs: '1.3', text: 'reply text'}), {channelId: 'C0INBOX', ts: '2.1'}, 'the root itself never counts as its own reply');
  assert.ok(sent[0].metadata, 'metadata is attempted first');
  assert.equal(sent[0].thread_ts, '1.3');
  refuseMetadata = true;
  await poster.post({captureId: 'def', part: 'root', since: NOW.toISOString(), text: 'other'});
  assert.equal(sent[1].metadata, undefined, 'metadata is dropped after Slack refuses it');
  await poster.post({captureId: 'def', part: 'transcript', since: NOW.toISOString(), threadTs: '2.2', text: 'more'});
  assert.equal(sent[2].metadata, undefined, 'and stays off afterwards');
  assert.equal(poster.metadata, false);
  const unrelated = new SlackPoster({channel: {channelId: 'C0INBOX', name: 'inbox'}, token: 'xoxb-bot', userToken: 'xoxp-owner',
    call: async (method, token) => method === 'chat.postMessage' ? (() => { throw new Error('slack chat.postMessage failed: ratelimited'); })() : call(method, token, {})});
  await unrelated.verify();
  await assert.rejects(unrelated.post({captureId: 'ghi', part: 'root', since: NOW.toISOString(), text: 'z'}), /ratelimited/);
  assert.equal(unrelated.metadata, true, 'only a metadata refusal disables metadata');
  const botOnly = new SlackPoster({channel: {channelId: 'C0INBOX', name: 'inbox'}, token: 'xoxb-bot', userToken: '', call: async (method, token) => { assert.equal(token, 'xoxb-bot'); return call(method, token, {}); }});
  await botOnly.verify();
  assert.equal(botOnly.posterUserId, 'ULIV', 'without a user token the bot posts, exactly as before');
});

test('Slack poster edits a root with the token that posted it and demands confirmation', async () => {
  const edits = [];
  const call = async (method, token, args) => { edits.push([method, token, args]); return {ok: true, channel: args.channel, ts: args.ts === '9.9' ? '9.9' : undefined}; };
  const poster = new SlackPoster({channel: {channelId: 'C0INBOX', name: 'inbox'}, token: 'bot', call});
  assert.deepEqual(await poster.update({channelId: 'C0INBOX', ts: '9.9', text: 'new title'}), {channelId: 'C0INBOX', ts: '9.9'});
  assert.deepEqual(edits, [['chat.update', 'bot', {channel: 'C0INBOX', ts: '9.9', text: 'new title'}]]);
  await assert.rejects(poster.update({channelId: 'C0INBOX', ts: '9.8', text: 'x'}), /slack_confirmation_missing/);
});

test('rendering escapes Slack markup and picks a device emoji', () => {
  assert.deepEqual(['iPhone', 'Apple Watch', 'Mac', 'iPad', 'Vision'].map(deviceEmoji), ['📱', '⌚', '💻', '📱', '🎙️']);
  assert.equal(gist('one two three four five six seven eight nine ten eleven'), 'one two three four five six seven eight nine ten…');
  const row = {device_model: 'Mac', device_name: '<!channel>', captured_at: '2026-07-01T12:00:00Z', summary: 'a & b', kind: 'audio', transcript: '<@U1> hi', shortcut_version: SHORTCUT_VERSION};
  assert.equal(rootText(row, 'America/New_York'), '💻 · Wed, Jul 1, 8:00 AM · a &amp; b');
  assert.equal(rootText({...row, location_label: 'Brooklyn, NY'}, 'America/New_York'), '💻 · Wed, Jul 1, 8:00 AM · Brooklyn, NY · a &amp; b');
  assert.ok(!rootText(row, 'America/New_York').includes('Liv'), 'the root never mentions the agent');
  assert.match(transcriptText(row, 'https://x/a'), /^&lt;@U1&gt; hi\n\n<https:\/\/x\/a\|/);
  assert.ok(transcriptText({...row, transcript: 'w '.repeat(30000)}, 'https://x/a').length < 40000);
});
