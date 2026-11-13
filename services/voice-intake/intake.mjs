import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {promisify} from 'node:util';
import {SHORTCUT_VERSION} from './shortcut.mjs';

const exec = promisify(execFile);
export const MAX_TEXT_CHARS = 20_000;
const SLACK_TEXT_LIMIT = 39_000;
export const FFMPEG = '/opt/homebrew/bin/ffmpeg';

// Root-post glyph per device model, matched in order; the last entry is the
// fallback. 📟 is the closest Unicode has to a tablet.
export const DEVICE_EMOJI = [[/watch/i, '⌚'], [/mac/i, '💻'], [/ipad/i, '📟'], [/iphone/i, '📱'], [/./, '🎙️']];

// Container type is read from the bytes, never from the client's file name.
export function audioType(bytes) {
  const ascii = (start, end) => bytes.subarray(start, end).toString('latin1');
  if (ascii(4, 8) === 'ftyp') return {ext: 'm4a', mediaType: 'audio/mp4'};
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return {ext: 'wav', mediaType: 'audio/wav'};
  if (ascii(0, 4) === 'caff') return {ext: 'caf', mediaType: 'audio/x-caf'};
  if (ascii(0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return {ext: 'mp3', mediaType: 'audio/mpeg'};
  return null;
}

const invalid = (message) => Object.assign(new Error(message), {status: 400});
const label = (value, field) => {
  const text = String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 100) throw invalid(`invalid_${field}`);
  return text;
};

// Reads ffmpeg's volumedetect report: peak level in dBFS and the input duration.
// Digital silence reports -91.0 dB (or -inf); a missing field stays null.
export function parseVolumeDetect(stderr) {
  const level = /max_volume:\s*(-?[\d.]+|-inf)\s*dB/.exec(stderr)?.[1];
  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  return {maxVolume: level == null ? null : level === '-inf' ? -Infinity : Number(level),
    duration: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : null};
}

// A recording the Mac's input never heard transcribes to a Whisper hallucination,
// so it is refused before it becomes evidence. Unmeasured fields are not judged.
export function audioRejection({maxVolume, duration}, {minSeconds = 0.5, minDb = -50} = {}) {
  if (duration != null && duration < minSeconds) return 'too_short';
  if (maxVolume != null && maxVolume < minDb) return 'silent_audio';
  return null;
}

// Measures a capture with ffmpeg. A broken or missing ffmpeg is logged and skipped
// so intake keeps working; only a completed measurement can reject.
export function audioGuard({ffmpeg = FFMPEG, minSeconds, minDb, timeoutMs = 30_000, log = (entry) => console.error(JSON.stringify(entry))} = {}) {
  return async (bytes, ext) => {
    const dir = await mkdtemp(join(tmpdir(), 'voice-intake-guard-'));
    try {
      const path = join(dir, `clip.${ext}`);
      await writeFile(path, bytes, {mode: 0o600});
      const {stderr} = await exec(ffmpeg, ['-nostdin', '-hide_banner', '-i', path, '-af', 'volumedetect', '-f', 'null', '-'], {timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024});
      return audioRejection(parseVolumeDetect(stderr), {minSeconds, minDb});
    } catch (error) {
      log({at: new Date().toISOString(), event: 'audio_guard_skipped', detail: String(error.code ?? error.message).slice(0, 200)});
      return null;
    } finally { await rm(dir, {recursive: true, force: true}); }
  };
}

// Normalizes a capture form. The capture id is derived from content, device and
// capture time, so a retried upload of the same recording is the same capture.
export async function normalizeCapture(form, {maxBytes, now = new Date(), guard}) {
  const deviceName = label(form.get('deviceName'), 'device_name');
  const deviceModel = label(form.get('deviceModel'), 'device_model');
  const captured = Date.parse(String(form.get('capturedAt') ?? ''));
  if (!Number.isFinite(captured) || captured > now.getTime() + 5 * 60_000) throw invalid('invalid_captured_at');
  const audio = form.get('audio'), text = form.get('text');
  let kind, bytes, type;
  if (typeof audio === 'string') throw invalid(audio ? 'audio_not_file' : 'empty_audio');
  if (audio && typeof audio === 'object' && text == null) {
    bytes = Buffer.from(await audio.arrayBuffer());
    if (!bytes.length) throw invalid('empty_audio');
    if (bytes.length > maxBytes) throw Object.assign(new Error('oversized'), {status: 413});
    type = audioType(bytes);
    if (!type) throw Object.assign(new Error('unsupported_audio'), {status: 415});
    const rejection = guard && await guard(bytes, type.ext);
    if (rejection) throw invalid(rejection);
    kind = 'audio';
  } else if (typeof text === 'string' && audio == null) {
    const value = text.trim();
    if (!value) throw invalid('empty_text');
    if (value.length > MAX_TEXT_CHARS) throw invalid('text_too_long');
    bytes = Buffer.from(value, 'utf8');
    type = {ext: 'txt', mediaType: 'text/plain; charset=utf-8'};
    kind = 'dictation';
  } else throw invalid('audio_or_text_required');
  const capturedAt = new Date(captured).toISOString();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  // Location and shortcut version are excluded from the id: a retried upload may carry a fresher fix and is still the same capture.
  const id = createHash('sha256').update(JSON.stringify([kind, deviceName, deviceModel, capturedAt, sha256])).digest('hex').slice(0, 32);
  return {id, kind, deviceName, deviceModel, capturedAt, sha256, bytes, ...type, shortcutVersion: shortcutVersion(form), ...normalizeLocation(form)};
}

// The Shortcut names its own version since v4; anything missing or unreadable is
// pre-v4 (null) and never rejects the capture. The service only reports drift.
export function shortcutVersion(form) {
  const value = Number(String(form.get('shortcutVersion') ?? '').trim());
  return Number.isInteger(value) && value > 0 ? value : null;
}
export const versionLabel = (version) => version == null ? `pre-v${SHORTCUT_VERSION}` : `v${version}`;
export const outdatedShortcut = (version) => (version ?? 0) < SHORTCUT_VERSION;
// What the Shortcut shows as its notification after an upload: the version it
// runs, and when behind, that a newer build exists.
export function sentMessage({status, shortcutVersion}) {
  const sent = status === 'duplicate' ? 'Already sent ✓' : 'Sent ✓';
  return outdatedShortcut(shortcutVersion) ? `${sent} · shortcut ${versionLabel(shortcutVersion)} is outdated, v${SHORTCUT_VERSION} is available` : `${sent} · v${shortcutVersion}`;
}

// Optional device location. The Shortcut sends it only when the device had a
// fix, so anything missing or unreadable is simply absent and never rejects
// the capture. Coordinates stay in the data plane; only the label reaches Slack.
export function normalizeLocation(form) {
  const number = (key, limit) => { const raw = String(form.get(key) ?? '').trim(), n = Number(raw); return raw && Number.isFinite(n) && Math.abs(n) <= limit ? Math.round(n * 1e6) / 1e6 : null; };
  const part = (key) => String(form.get(key) ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) || null;
  const latitude = number('latitude', 90), longitude = number('longitude', 180);
  const city = part('locationCity'), state = part('locationState');
  const label = city && state ? `${city}, ${state}` : city ?? state ?? part('locationName');
  return {latitude: latitude != null && longitude != null ? latitude : null, longitude: latitude != null && longitude != null ? longitude : null, locationLabel: label};
}

export function deviceEmoji(model) {
  return DEVICE_EMOJI.find(([pattern]) => pattern.test(model ?? ''))?.[1] ?? DEVICE_EMOJI.at(-1)[1];
}

const escapeMrkdwn = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Deterministic fallback when no local summarizer answers.
export function gist(transcript, words = 10) {
  const parts = String(transcript).replace(/\s+/g, ' ').trim().split(' ');
  return parts.length > words ? `${parts.slice(0, words).join(' ')}…` : parts.join(' ');
}

// Whisper's stock output for silence or noise. Asking a model to summarize it
// yields a complaint about the missing note, so these keep the transcript as title.
export const SILENCE_HALLUCINATIONS = new Set(['you', 'thank you', 'thanks', 'thank you for watching', 'thanks for watching', 'thank you for listening',
  'thanks for listening', 'bye', 'goodbye', 'see you next time', 'subtitles by the amara org community', 'please subscribe', 'the end']);
export function trivialTranscript(transcript, minWords = 4) {
  const words = String(transcript).toLowerCase().replace(/[^\p{L}\p{N}']+/gu, ' ').trim().split(' ').filter(Boolean);
  return words.length < minWords || SILENCE_HALLUCINATIONS.has(words.join(' '));
}

// The root is only the title; Slack shows the time, and the first reply carries the details.
export function rootText(row) {
  return escapeMrkdwn(row.summary);
}

export function transcriptText(row, audioUrl) {
  const link = (row.kind === 'audio' ? `\n\n<${audioUrl}|🎧 Original audio>` : '\n\n_Dictated on device; no audio was recorded._')
    + (outdatedShortcut(row.shortcut_version) ? `\n_Shortcut ${versionLabel(row.shortcut_version)}, current is v${SHORTCUT_VERSION}_` : '');
  const head = escapeMrkdwn(`${deviceEmoji(row.device_model)}${row.location_label ? ` · ${row.location_label}` : ''}`) + '\n\n';
  const body = escapeMrkdwn(row.transcript);
  const room = SLACK_TEXT_LIMIT - head.length - link.length - 40;
  return `${head}${body.length > room ? `${body.slice(0, room)}… _(truncated; full text in the capture record)_` : body}${link}`;
}

const location = ({latitude, longitude, locationLabel}) => latitude == null && !locationLabel ? null : {latitude, longitude, label: locationLabel};

export function livMessage(requestPath) {
  return [
    'Owner voice capture. The device held the instance capture credential at the edge; that is the authority for this turn.',
    `Read the private request record at ${requestPath}. Treat its transcript exactly as if the owner had typed it in this Slack thread, and act on it with your normal tools and permissions.`,
    'The transcript is machine speech recognition. If a misheard word or name would change a consequential action, ask one clarification in this thread first.',
    'The root post and the transcript reply already exist in this thread; do not repost them. Your reply lists the actions you took, each with a link to the Notion page, file, artifact, or task touched. If no action was warranted, say so in one line.',
    'Preserve normal merge, restart, public-action, and privacy approval boundaries. Never upload or attach the audio. Reply through normal session delivery; do not also send a duplicate message.',
  ].join('\n');
}

// One row per capture id. States: received -> transcribed -> rooted -> posted ->
// dispatching -> dispatched, and held(reason) when an outcome is failed or unknown.
export class Store {
  constructor(path) {
    mkdirSync(dirname(path), {recursive: true, mode: 0o700});
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS voice_captures (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, device_name TEXT NOT NULL, device_model TEXT NOT NULL,
        captured_at TEXT NOT NULL, received_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        evidence_path TEXT NOT NULL, media_type TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL,
        state TEXT NOT NULL, reason TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        transcript TEXT, summary TEXT, channel_id TEXT, root_ts TEXT, transcript_ts TEXT, session_key TEXT, run_id TEXT,
        latitude REAL, longitude REAL, location_label TEXT, shortcut_version INTEGER);`);
    // A ledger created before location or versioning existed gains the columns in place.
    const columns = new Set(this.db.prepare('PRAGMA table_info(voice_captures)').all().map(c => c.name));
    for (const [name, type] of [['latitude', 'REAL'], ['longitude', 'REAL'], ['location_label', 'TEXT'], ['shortcut_version', 'INTEGER']]) if (!columns.has(name)) this.db.exec(`ALTER TABLE voice_captures ADD COLUMN ${name} ${type}`);
  }
  insert(capture, evidencePath) {
    const now = new Date().toISOString();
    return this.db.prepare(`INSERT OR IGNORE INTO voice_captures (id, kind, device_name, device_model, captured_at, received_at, updated_at,
      evidence_path, media_type, bytes, sha256, state, latitude, longitude, location_label, shortcut_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?, ?, ?)`)
      .run(capture.id, capture.kind, capture.deviceName, capture.deviceModel, capture.capturedAt, now, now,
        evidencePath, capture.mediaType, capture.bytes.length, capture.sha256, capture.latitude, capture.longitude, capture.locationLabel, capture.shortcutVersion ?? null).changes === 1;
  }
  get(id) { return this.db.prepare('SELECT * FROM voice_captures WHERE id=?').get(id); }
  update(id, fields) {
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE voice_captures SET ${keys.map(k => `${k}=?`).join(', ')}, updated_at=? WHERE id=?`)
      .run(...keys.map(k => fields[k] ?? null), new Date().toISOString(), id);
  }
  open() { return this.db.prepare(`SELECT * FROM voice_captures WHERE state NOT IN ('dispatched', 'held') ORDER BY rowid`).all(); }
  health() {
    const count = (state) => this.db.prepare('SELECT count(*) AS n FROM voice_captures WHERE state=?').get(state).n;
    const open = this.db.prepare(`SELECT count(*) AS n FROM voice_captures WHERE state NOT IN ('dispatched', 'held')`).get().n;
    return {sqlite: this.db.prepare('PRAGMA quick_check').get().quick_check === 'ok', open, held: count('held')};
  }
  close() { this.db.close(); }
}

// Optional local summarizer (Ollama on loopback). Any failure uses the gist.
export function ollamaSummarizer({url = 'http://127.0.0.1:11434', model, timeoutMs = 120_000} = {}) {
  return async (transcript) => {
    if (!model) return gist(transcript);
    try {
      const response = await fetch(`${url}/api/generate`, {method: 'POST', signal: AbortSignal.timeout(timeoutMs), headers: {'content-type': 'application/json'},
        body: JSON.stringify({model, stream: false, think: false, options: {num_predict: 40, temperature: 0.2},
          prompt: `Summarize this voice note in at most eight words, as a plain title. Reply with only the title.\n\n${transcript.slice(0, 8000)}`})});
      const line = String((await response.json()).response ?? '').split('\n').map(s => s.trim()).find(Boolean) ?? '';
      const clean = line.replace(/^["'*#\s]+|["'*.\s]+$/g, '').slice(0, 80);
      return clean || gist(transcript);
    } catch { return gist(transcript); }
  };
}

export class VoiceIntake {
  constructor({store, config, evidenceRoot, requestsDir, transcribe, summarize, guard, slack, gateway, now = () => new Date(), log = (entry) => console.error(JSON.stringify(entry))}) {
    Object.assign(this, {store, config, evidenceRoot, requestsDir, transcribe, summarize, guard, slack, gateway, now, log});
    this.serial = Promise.resolve();
    this.retitles = new Set();
  }

  // Resolves once the serial worker and every in-flight retitle have finished.
  async idle() { await this.serial; await Promise.allSettled([...this.retitles]); }

  audioUrl(id) { return `${this.config.privateOrigin}${this.config.audioPath ?? '/voice-intake/audio/'}${id}`; }

  // Evidence is written before the row exists, create-only. A crash between the two
  // writes leaves identical bytes that the retried upload finds and keeps.
  async accept(form) {
    const capture = await normalizeCapture(form, {maxBytes: this.config.maxBytes ?? 50 * 1024 * 1024, now: this.now(), guard: this.guard});
    if (this.store.get(capture.id)) return {status: 'duplicate', captureId: capture.id, shortcutVersion: capture.shortcutVersion};
    const day = capture.capturedAt.slice(0, 10).split('-');
    const directory = join(this.evidenceRoot, day[0], day[1]);
    const path = join(directory, `${capture.id}.${capture.ext}`);
    mkdirSync(directory, {recursive: true, mode: 0o700});
    if (!existsSync(path)) writeFileSync(path, capture.bytes, {mode: 0o600, flag: 'wx'});
    else if (createHash('sha256').update(readFileSync(path)).digest('hex') !== capture.sha256) throw new Error('evidence_conflict');
    const meta = `${path.replace(/\.[^.]+$/, '')}.json`;
    if (!existsSync(meta)) writeFileSync(meta, JSON.stringify({schemaVersion: 1, captureId: capture.id, kind: capture.kind,
      deviceName: capture.deviceName, deviceModel: capture.deviceModel, capturedAt: capture.capturedAt, receivedAt: this.now().toISOString(),
      mediaType: capture.mediaType, bytes: capture.bytes.length, sha256: capture.sha256, shortcutVersion: capture.shortcutVersion, location: location(capture)}, null, 2), {mode: 0o600, flag: 'wx'});
    return {status: this.store.insert(capture, path) ? 'accepted' : 'duplicate', captureId: capture.id, shortcutVersion: capture.shortcutVersion};
  }

  drain() {
    this.serial = this.serial.then(async () => { for (const row of this.store.open()) await this.advance(row.id); }).catch(() => {});
    return this.serial;
  }

  async advance(id) {
    let row = this.store.get(id);
    const hold = (reason) => this.store.update(id, {state: 'held', reason});
    const timing = {};
    const timed = async (name, work) => { const started = Date.now(); try { return await work(); } finally { timing[name] = Date.now() - started; } };
    try {
      if (row.state === 'received') {
        // The root is titled with the transcript's first words so it posts as soon
        // as transcription ends; the summarizer retitles it afterwards.
        const transcript = row.kind === 'audio' ? await timed('transcribeMs', () => this.transcribe(row.evidence_path)) : readFileSync(row.evidence_path, 'utf8');
        if (!transcript) return hold('empty_transcript');
        this.store.update(id, {state: 'transcribed', transcript, summary: gist(transcript)});
        row = this.store.get(id);
      }
      if (row.state === 'transcribed') {
        const root = await timed('rootMs', () => this.slack.post({captureId: id, part: 'root', since: row.received_at, text: rootText(row)}));
        this.store.update(id, {state: 'rooted', channel_id: root.channelId, root_ts: root.ts});
        row = this.store.get(id);
        this.log({at: this.now().toISOString(), event: 'capture_rooted', captureId: id, ...timing, sinceReceivedMs: Date.now() - Date.parse(row.received_at)});
        if (!trivialTranscript(row.transcript)) this.retitle(row);
      }
      if (row.state === 'rooted') {
        const reply = await this.slack.post({captureId: id, part: 'transcript', since: row.received_at, threadTs: row.root_ts, text: transcriptText(row, this.audioUrl(id))});
        this.store.update(id, {state: 'posted', transcript_ts: reply.ts});
        row = this.store.get(id);
      }
      if (row.state === 'dispatching') {
        // RPC idempotency is not guaranteed across gateway restarts. An unknown
        // admission is reconciled from the run, never blindly re-executed.
        const observed = await this.gateway('agent.wait', {runId: row.run_id, timeoutMs: 1}).catch(() => null);
        return observed?.runId === row.run_id && observed.status === 'ok' ? this.store.update(id, {state: 'dispatched'}) : hold('admission_unconfirmed');
      }
      if (row.state === 'posted') {
        const params = this.sessionRequest(row);
        this.store.update(id, {state: 'dispatching', session_key: params.sessionKey, run_id: params.idempotencyKey});
        const result = await this.gateway('agent', params).catch(() => null);
        if (result?.runId !== params.idempotencyKey || !['accepted', 'ok'].includes(result.status)) return hold('admission_unconfirmed');
        this.store.update(id, {state: 'dispatched'});
      }
    } catch {
      // Transcription and reconciled Slack posts are safe to repeat, so they retry before holding.
      const attempts = row.attempts + 1;
      this.store.update(id, attempts >= (this.config.maxAttempts ?? 5) ? {attempts, state: 'held', reason: `${row.state}_failed`} : {attempts});
    }
  }

  // Replaces the root's provisional title with the summarizer's, off the critical
  // path. Any failure leaves the first-words title, which is already correct.
  retitle(row) {
    const started = Date.now();
    const work = (async () => {
      const summary = await this.summarize(row.transcript);
      if (!summary || summary === row.summary) return;
      await this.slack.update({channelId: row.channel_id, ts: row.root_ts, text: rootText({...row, summary})});
      this.store.update(row.id, {summary});
      this.log({at: this.now().toISOString(), event: 'capture_retitled', captureId: row.id, summaryMs: Date.now() - started});
    })().catch(error => this.log({at: this.now().toISOString(), event: 'retitle_failed', captureId: row.id, detail: String(error.message).slice(0, 200)}))
      .finally(() => this.retitles.delete(work));
    this.retitles.add(work);
    return work;
  }

  sessionRequest(row) {
    const directory = join(this.requestsDir, row.id);
    mkdirSync(directory, {recursive: true, mode: 0o700});
    const requestPath = join(directory, 'request.json');
    if (!existsSync(requestPath)) writeFileSync(requestPath, JSON.stringify({source: 'voice-intake', captureId: row.id, kind: row.kind,
      device: {name: row.device_name, model: row.device_model}, capturedAt: row.captured_at, location: location({latitude: row.latitude, longitude: row.longitude, locationLabel: row.location_label}),
      audioUrl: row.kind === 'audio' ? this.audioUrl(row.id) : null,
      evidencePath: row.evidence_path, transcript: row.transcript}, null, 2), {mode: 0o600, flag: 'wx'});
    const agentId = this.config.agentId;
    return {
      agentId, sessionKey: `agent:${agentId}:slack:channel:${row.channel_id.toLowerCase()}:thread:${row.root_ts}`,
      channel: 'slack', accountId: agentId, replyChannel: 'slack', replyAccountId: agentId,
      replyTo: `channel:${row.channel_id}`, threadId: row.root_ts, deliver: true,
      idempotencyKey: `voice-intake:${row.id}`, message: livMessage(requestPath),
    };
  }
}

// Posts as the owner when the instance supplies a user token, else as the
// agent's bot. Reads and verification always use the bot token, so the user
// token needs only chat:write. Each post carries metadata naming its capture
// and part, so a lost response is reconciled instead of reposted; when Slack
// refuses metadata for the posting token, posts match on author and text.
export class SlackPoster {
  constructor({channel, token, userToken, call, eventType = 'voice_intake'}) { Object.assign(this, {channel, token, userToken: userToken || undefined, call, eventType, metadata: true}); }
  async verify() {
    const auth = await this.call('auth.test', this.token, {});
    const {channel} = await this.call('conversations.info', this.token, {channel: this.channel.channelId});
    if (!auth.user_id || channel?.name !== this.channel.name || channel.is_archived || !channel.is_member) throw new Error('inbox_unavailable');
    const poster = this.userToken ? await this.call('auth.test', this.userToken, {}) : auth;
    if (!poster.user_id) throw new Error('inbox_unavailable');
    this.botUserId = auth.user_id;
    this.posterUserId = poster.user_id;
  }
  async post({captureId, part, since, threadTs, text}) {
    // Without the poster's own id a lost post could not be recognized, so never post.
    if (!this.posterUserId) throw new Error('slack_unverified');
    const marker = `${captureId}:${part}`;
    let cursor;
    do {
      const page = await this.call(threadTs ? 'conversations.replies' : 'conversations.history', this.token, {channel: this.channel.channelId, ts: threadTs,
        oldest: String(Date.parse(since) / 1000 - 60), limit: 200, include_all_metadata: true, cursor});
      const found = page.messages?.find(m => m.user === this.posterUserId && (m.metadata
        ? m.metadata.event_type === this.eventType && m.metadata.event_payload?.marker === marker
        : m.text === text && (threadTs ? m.ts !== threadTs : !m.thread_ts || m.thread_ts === m.ts)));
      if (found) return {channelId: this.channel.channelId, ts: found.ts};
      cursor = page.response_metadata?.next_cursor;
    } while (cursor);
    const body = {channel: this.channel.channelId, thread_ts: threadTs, text, unfurl_links: false, unfurl_media: false};
    const metadata = JSON.stringify({event_type: this.eventType, event_payload: {marker}});
    let result;
    try {
      result = await this.call('chat.postMessage', this.userToken ?? this.token, this.metadata ? {...body, metadata} : body);
    } catch (error) {
      if (!this.metadata || !/metadata/i.test(error.message)) throw error;
      this.metadata = false;
      result = await this.call('chat.postMessage', this.userToken ?? this.token, body);
    }
    if (!result.ts || result.channel !== this.channel.channelId) throw new Error('slack_confirmation_missing');
    return {channelId: result.channel, ts: result.ts};
  }
  // Edits a post this poster made, with the token that made it.
  async update({channelId, ts, text}) {
    const result = await this.call('chat.update', this.userToken ?? this.token, {channel: channelId, ts, text});
    if (result.ts !== ts) throw new Error('slack_confirmation_missing');
    return {channelId, ts};
  }
}
