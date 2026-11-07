import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store, VoiceIntake} from './intake.mjs';

// Synthetic capture fixtures; no Slack, gateway, Whisper, or network.
export const M4A = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypM4A '), Buffer.alloc(64, 1)]);
export const NOW = new Date('2026-11-06T16:05:00Z');

export function captureForm({audio = M4A, text, deviceName = 'Ariel’s iPhone', deviceModel = 'iPhone', capturedAt = '2026-11-06T11:03:12-05:00'} = {}) {
  const form = new FormData();
  if (audio) form.append('audio', new Blob([audio]), 'Recording.m4a');
  if (text != null) form.append('text', text);
  form.append('deviceName', deviceName); form.append('deviceModel', deviceModel); form.append('capturedAt', capturedAt);
  return form;
}

export function fixture({transcribe = async () => 'Remind me to book the vet for Pepe next week.', gateway, guard} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'voice-intake-'));
  const posts = [], calls = [];
  const slack = {post: async (args) => { posts.push(args); return {channelId: 'C0INBOX', ts: `1793.${posts.length}`}; }};
  const intake = new VoiceIntake({
    store: new Store(join(root, 'captures.sqlite3')), slack, transcribe, guard, summarize: async () => 'Book vet for Pepe',
    gateway: gateway ?? (async (method, params) => { calls.push([method, params]); return {runId: params.idempotencyKey, status: 'accepted'}; }),
    config: {agentId: 'liv', privateOrigin: 'https://os.example.test', timeZone: 'America/New_York'},
    evidenceRoot: join(root, 'evidence'), requestsDir: join(root, 'requests'), now: () => NOW,
  });
  return {root, intake, posts, calls};
}
