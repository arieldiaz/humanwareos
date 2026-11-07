import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store, VoiceIntake} from './intake.mjs';
import {SHORTCUT_VERSION} from './shortcut.mjs';

// Synthetic capture fixtures; no Slack, gateway, Whisper, or network.
export const M4A = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypM4A '), Buffer.alloc(64, 1)]);
export const NOW = new Date('2026-11-06T16:05:00Z');

export function captureForm({audio = M4A, text, deviceName = 'Ariel’s iPhone', deviceModel = 'iPhone', capturedAt = '2026-11-06T11:03:12-05:00', location, shortcutVersion = String(SHORTCUT_VERSION)} = {}) {
  const form = new FormData();
  if (audio) form.append('audio', new Blob([audio]), 'Recording.m4a');
  if (text != null) form.append('text', text);
  form.append('deviceName', deviceName); form.append('deviceModel', deviceModel); form.append('capturedAt', capturedAt);
  if (shortcutVersion != null) form.append('shortcutVersion', shortcutVersion);
  for (const [key, value] of Object.entries(location ?? {})) form.append(key, value);
  return form;
}
export const BROOKLYN = {latitude: '40.678178', longitude: '-73.944158', locationCity: 'Brooklyn', locationState: 'NY', locationName: '123 Example St'};

export function fixture({transcribe = async () => 'Remind me to book the vet for Pepe next week.', summarize = async () => 'Book vet for Pepe', gateway, guard} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'voice-intake-'));
  const posts = [], updates = [], calls = [], logs = [];
  const slack = {
    post: async (args) => { posts.push(args); return {channelId: 'C0INBOX', ts: `1793.${posts.length}`}; },
    update: async (args) => { updates.push(args); return {channelId: args.channelId, ts: args.ts}; },
  };
  const intake = new VoiceIntake({
    store: new Store(join(root, 'captures.sqlite3')), slack, transcribe, guard, summarize,
    gateway: gateway ?? (async (method, params) => { calls.push([method, params]); return {runId: params.idempotencyKey, status: 'accepted'}; }),
    config: {agentId: 'liv', privateOrigin: 'https://os.example.test', timeZone: 'America/New_York'},
    evidenceRoot: join(root, 'evidence'), requestsDir: join(root, 'requests'), now: () => NOW, log: (entry) => logs.push(entry),
  });
  return {root, intake, posts, updates, calls, logs};
}
