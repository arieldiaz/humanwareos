import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {decodeFinal, validateEvidence} from './final-envelope.mjs';
import {FinalRuntime} from './final-runtime.mjs';
const wire = (status = 'act', message = 'A result.\n\n## Session Closed') => JSON.stringify({schemaVersion: 1, message, status});

test('whole JSON envelope only; prose cannot select status', () => {
  assert.equal(decodeFinal(wire()).status, 'act');
  for (const text of ['plain reply', '```json\n'+wire()+'\n```', wire()+' trailing', wire('done'), wire('working'), wire('act',' '), '{"schemaVersion":1,"message":"x","status":"act","extra":true}'])
    assert.throws(() => decodeFinal(text));
});
test('scheduled and closed require host evidence', () => {
  assert.throws(() => validateEvidence(decodeFinal(wire('scheduled')), {}));
  assert.throws(() => validateEvidence(decodeFinal(wire('closed')), {}));
  assert.equal(validateEvidence(decodeFinal(wire('scheduled')), {wakes: [{enabled: true, nextRunAtMs: Date.now()+1000}]}).status, 'scheduled');
});
async function fixture(t, agent = 'max') {
  const root = await mkdtemp(join(tmpdir(), 'final-contract-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const records = [], projections = [], faults = [], sends = [];
  const sessionKey = `agent:${agent}:slack:channel:c123:thread:1790050400.000001`;
  const runtime = new FinalRuntime({root, humanInputs: new Map(), fences: {shouldSuppress: () => false},
    project: async s => projections.push(s), record: async s => records.push(s), fault: async (_, e) => faults.push(e),
    wakes: async () => [], close: async () => {}, send: async turn => { sends.push(turn); return {messageId: 'receipt'}; }});
  return {runtime, projections, records, faults, sends, params: {sessionKey, runId: 'r1', agentId: agent, prompt: 'Answer'}};
}
for (const agent of ['liv', 'max']) for (const kind of ['cursor', 'codex']) {
  test(`${agent}/${kind}: one decision, unchanged message, idempotent receipt`, async t => {
    const {runtime, params, records, projections, sends} = await fixture(t, agent);
    const result = kind === 'cursor' ? {payloads: [{text: wire()}]} : {terminal: {kind: 'ok'}, assistantTexts: [wire()]};
    await runtime.run(params, async () => result, kind);
    const event = {runId: params.runId, sessionKey: params.sessionKey, kind: 'final', payload: {text: wire()}};
    assert.equal((await runtime.prepare(event, params)).cancel, true);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].envelope.message, decodeFinal(wire()).message);
    await runtime.deliver(sends[0].key);
    assert.equal(sends.length, 1);
    assert.deepEqual(projections, ['working','act']);
    assert.deepEqual(records.map(r => r.status), ['working','act']);
  });
}
test('one repair; exhausted repair clears first working, never invents act', async t => {
  const {runtime, params, projections, faults} = await fixture(t);
  let calls = 0;
  await assert.rejects(runtime.run(params, async () => { calls++; return {payloads: [{text: 'invalid'}]}; }, 'cursor'));
  assert.equal(calls, 2); assert.equal(faults.length, 1);
  assert.deepEqual(projections, ['working', undefined]);
});
test('repair resumes the returned Cursor session and can succeed', async t => {
  const {runtime, params} = await fixture(t);
  let calls = 0;
  await runtime.run(params, async input => {
    if (++calls === 1) return {payloads: [{text: 'bad'}], meta: {agentMeta: {sessionId: 'native-session'}}};
    assert.equal(input.cliSessionId, 'native-session');
    assert.deepEqual(input.toolsAllow, []);
    return {payloads: [{text: wire()}]};
  }, 'cursor');
  assert.equal(calls, 2);
});
test('a failed later run restores the prior committed terminal', async t => {
  const {runtime, params, projections} = await fixture(t);
  await runtime.run(params, async () => ({assistantTexts: [wire()]}), 'codex');
  await assert.rejects(runtime.run({...params, runId: 'r2'}, async () => ({assistantTexts: ['bad']}), 'codex'));
  assert.deepEqual(projections, ['working','act','working','act']);
});
test('closure gate rejects a current human message without confirmation', () => {
  assert.throws(() => validateEvidence(decodeFinal(wire('closed')), {humanInput: {messageId: '1', text: 'what changed?'}}));
  assert.equal(validateEvidence(decodeFinal(wire('closed')), {humanInput: {messageId: '2', text: 'close this thread'}}).status, 'closed');
});
test('a delivered decision survives projection failure and recovers without another send', async t => {
  const {runtime, params, sends} = await fixture(t);
  const project = runtime.project;
  runtime.project = async status => {if (status === 'act') throw new Error('Slack rate limit'); return project(status);};
  await assert.rejects(runtime.run(params, async () => ({assistantTexts: [wire()]}), 'codex'));
  assert.equal(sends.length, 1);
  runtime.project = project;
  await runtime.recover();
  assert.equal(sends.length, 1);
});
test('a live same-session wake validates scheduling, a different-session wake cannot', async t => {
  const {runtime, params, sends} = await fixture(t);
  const job = {id: 'wake', enabled: true, sessionKey: params.sessionKey, payload: {kind: 'agentTurn'}, state: {nextRunAtMs: Date.now()+60_000}};
  runtime.wakes = async () => [job];
  await runtime.run(params, async () => ({assistantTexts: [wire('scheduled','Scheduled.')]}), 'codex');
  assert.equal(sends[0].envelope.status, 'scheduled');
  runtime.wakes = async () => [{...job, sessionKey: 'different'}];
  await assert.rejects(runtime.run({...params, runId: 'r2'}, async () => ({assistantTexts: [wire('scheduled')]}), 'codex'));
  assert.equal(sends.length, 1);
});
test('a new human admission supersedes a pending old final before model execution', async t => {
  const {runtime, params, sends} = await fixture(t);
  runtime.fences.reopenFromHuman = async () => {};
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const old = runtime.run(params, async () => {started(); await waiting; return {assistantTexts: [wire()]};}, 'codex');
  await entered;
  await runtime.human(runtime.route(params), {messageId: 'new', text: 'Different request'});
  finish();
  await assert.rejects(old, /Superseded/);
  assert.equal(sends.length, 0);
});
test('repeated inbound delivery does not supersede its own running turn', async t => {
  const {runtime, params, sends} = await fixture(t);
  runtime.fences.reopenFromHuman = async () => {};
  const input = {messageId: 'same', text: 'Answer'};
  await runtime.human(runtime.route(params), input);
  await runtime.run(params, async () => {
    await runtime.human(runtime.route(params), input);
    return {assistantTexts: [wire()]};
  }, 'codex');
  assert.equal(sends.length, 1);
});
test('host attachments survive final delivery without duplicating tool-sent media', async t => {
  const {runtime, params, sends} = await fixture(t);
  await runtime.run(params, async () => ({assistantTexts: [wire()], toolMediaUrls: ['first.png','sent.png'], messagingToolSentMediaUrls: ['sent.png']}), 'codex');
  assert.deepEqual(sends[0].mediaUrls, ['first.png']);
});
