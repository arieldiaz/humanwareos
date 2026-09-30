import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {planLifecycleMigration, stageLifecycleMigration} from './lifecycle-migration.mjs';
import {FinalRuntime} from './final-runtime.mjs';
import {shouldSuppressConversationDelivery} from './conversation-fence.mjs';
const route = {channel: 'C123', threadId: '1700000000.000001'}, key = 'slack:C123:1700000000.000001';
const closed = {state: 'closed', revision: 9, openedAt: 100, updatedAt: 300, closedAt: 300,
  closedThrough: 300, closeMessageId: '1700000100.000001'};
function input(fence = closed) {
  return {fences: {schemaVersion: 1, conversations: {[key]: structuredClone(fence)}},
    journal: {turns: {}, conversations: {[key]: {status: fence.state === 'closed' ? 'closed' : 'act'}}}};
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'lifecycle-migration-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  return root;
}

test('preserves baseline closed/open boundaries, provenance and historical turns without inventing events', () => {
  for (const fence of [closed, {...closed, state: 'open', revision: 10, updatedAt: 400, reopenedAt: 400, reopenedByMessageId: '1700000200.000001'}]) {
    const source = input(fence), turnKey = key + ':old';
    source.journal.turns[turnKey] = {key: turnKey, conversation: key, phase: 'sent', startedAt: 200, envelope: {status: 'closed', message: 'historical report'}};
    const original = structuredClone(source), plan = planLifecycleMigration(source);
    assert.equal(plan.ready, true, JSON.stringify(plan.issues));
    assert.deepEqual(source, original);
    assert.equal(plan.journal.conversations[key].generation, 0);
    assert.deepEqual(plan.journal.conversations[key].legacyBoundary, fence);
    assert.equal(plan.journal.conversations[key].closedThrough, 300);
    assert.deepEqual(plan.journal.turns, source.journal.turns);
    assert.equal(plan.journal.closes, undefined);
    assert.equal(plan.before.turns, plan.after.turns);
    const rerun = planLifecycleMigration({...source, journal: plan.journal});
    assert.equal(rerun.ready, true); assert.equal(rerun.noOp, true);
    assert.deepEqual(rerun.journal, plan.journal);
  }
});

test('boundary-only legacy rows are retained, while a turn without its conversation blocks', () => {
  const source = input(); source.journal.conversations = {};
  const plan = planLifecycleMigration(source);
  assert.equal(plan.ready, true); assert.equal(plan.after.closed, 1); assert.equal(plan.before.closed, 0);
  source.journal.turns.bad = {key: 'bad', conversation: key, phase: 'queued', startedAt: 200};
  assert.equal(planLifecycleMigration(source).ready, false);
});

test('A first-touch import may have advanced: preserve its generation, sender and newer fence', () => {
  const source = input();
  source.journal.conversations[key] = {...closed, generation: 1, state: 'open', status: 'act',
    legacyBoundary: closed, sender: 'liv', lastHumanMessage: '1700000200.000001'};
  const plan = planLifecycleMigration(source);
  assert.equal(plan.ready, true, JSON.stringify(plan.issues));
  assert.deepEqual(plan.journal.conversations[key], source.journal.conversations[key]);
  assert.equal(plan.alreadyVersioned, 1);
  source.journal.conversations[key].closedThrough = 299;
  assert.ok(planLifecycleMigration(source).issues.some(issue => issue.code === 'lost_historical_boundary'));
  source.journal.conversations[key].closedThrough = 300;
  source.journal.conversations[key].legacyBoundary = {...closed, closeMessageId: 'changed'};
  assert.ok(planLifecycleMigration(source).issues.some(issue => issue.code === 'legacy_provenance_mismatch'));
});

test('modern complete host operations survive unchanged; active or orphan close operations block', () => {
  const source = input({state: 'open', revision: 1, openedAt: 100, updatedAt: 100});
  const operation = key + ':close:0';
  source.journal.conversations[key] = {generation: 0, state: 'closed', status: 'closed', closedThrough: 500,
    closeOperation: operation, legacyBoundary: source.fences.conversations[key]};
  source.journal.closes = {[operation]: {key: operation, conversation: key, route, generation: 0, startedAt: 500,
    phase: 'complete', messageId: '1700000300.000001', snapshot: {report: 'Frozen report'}}};
  const plan = planLifecycleMigration(source);
  assert.equal(plan.ready, true, JSON.stringify(plan.issues));
  assert.deepEqual(plan.journal.closes, source.journal.closes);
  source.journal.closes[operation].phase = 'sending';
  assert.equal(planLifecycleMigration(source).ready, false);
  source.journal.closes = {};
  assert.equal(planLifecycleMigration(source).ready, false);
});

test('ambiguity, pending historical receipts, unknown schema and changed migration sources block', () => {
  for (const mutate of [
    s => {s.fences.conversations[key].state = 'closing';},
    s => {s.journal.conversations[key].status = 'act';},
    s => {delete s.fences.conversations[key].closedThrough;},
    s => {s.journal.lifecycleSchemaVersion = 2;},
    s => {s.journal.conversations[key].generation = -1;},
    s => {s.journal.turns.bad = {key: 'bad', conversation: key, phase: 'delivered', envelope: {status: 'closed'}};},
  ]) {
    const source = input(); mutate(source);
    assert.equal(planLifecycleMigration(source).ready, false);
  }
  const source = input(), migrated = planLifecycleMigration(source).journal;
  source.fences.conversations[key].revision++;
  assert.equal(planLifecycleMigration({...source, journal: migrated}).ready, false);
});

for (const boundary of ['before-write', 'before-publish', 'after-publish']) test(`interruption at ${boundary} resumes to one complete candidate`, async t => {
  const root = await fixture(t), path = join(root, 'candidate.json'), plan = planLifecycleMigration(input());
  await assert.rejects(stageLifecycleMigration(path, plan, {fault: async stage => {if (stage === boundary) throw new Error('interruption');}}), /interruption/);
  if (boundary !== 'after-publish') await assert.rejects(readFile(path), {code: 'ENOENT'});
  await stageLifecycleMigration(path, plan);
  const first = await readFile(path, 'utf8');
  await stageLifecycleMigration(path, plan);
  assert.equal(await readFile(path, 'utf8'), first);
  assert.deepEqual(JSON.parse(first), plan.journal);
  assert.deepEqual(await readdir(root), ['candidate.json']);
});

test('changed input verification and occupied output never overwrite a source or candidate', async t => {
  const root = await fixture(t), path = join(root, 'candidate.json'), plan = planLifecycleMigration(input());
  await assert.rejects(stageLifecycleMigration(path, plan, {verifySources: async () => {throw new Error('source changed');}}), /source changed/);
  await assert.rejects(readFile(path), {code: 'ENOENT'});
  await writeFile(path, 'keep');
  await assert.rejects(stageLifecycleMigration(path, plan), {code: 'EEXIST'});
  assert.equal(await readFile(path, 'utf8'), 'keep');
});

test('migrated closed boundary stays fenced after reopening; recovery never resends historical closure', async t => {
  const root = await fixture(t), source = input(), turnKey = key + ':old';
  source.journal.turns[turnKey] = {key: turnKey, conversation: key, route, phase: 'reserved', startedAt: 200,
    envelope: {schemaVersion: 1, status: 'act', message: 'late result'}};
  const plan = planLifecycleMigration(source);
  assert.equal(plan.ready, true);
  await stageLifecycleMigration(join(root, 'final-decisions.json'), plan);
  const sent = [], completed = [];
  const runtime = new FinalRuntime({root, project: async () => {}, record: async () => {}, fault: async () => {},
    wakes: async () => [], send: async turn => {sent.push(turn); return {messageId: 'new-receipt'};}, completeClose: async close => completed.push(close)});
  await assert.rejects(runtime.run({sessionKey: 'agent:max:slack:channel:c123:thread:1700000000.000001', runId: 'blocked'}, async () => assert.fail(), 'codex'), /fenced/);
  await runtime.human(route, {messageId: '1700000200.000001'});
  await runtime.recover();
  assert.equal(sent.length, 0); assert.equal(completed.length, 0);
  const journal = JSON.parse(await readFile(join(root, 'final-decisions.json')));
  assert.equal(journal.conversations[key].generation, 1);
  assert.equal(journal.conversations[key].closedThrough, 300);
  assert.equal(journal.turns[turnKey].phase, 'intentional_non_delivery');
  assert.equal(shouldSuppressConversationDelivery(route, {path: join(root, 'final-decisions.json'), workCreatedAt: 200}), true);
  await runtime.run({sessionKey: 'agent:max:slack:channel:c123:thread:1700000000.000001', runId: 'fresh'},
    async () => ({assistantTexts: [JSON.stringify({schemaVersion: 1, status: 'act', message: 'fresh work'})]}), 'codex');
  assert.equal(sent.length, 1);
});

test('CLI defaults to dry-run, stages explicitly, refuses input paths and labels absent evidence', async t => {
  const root = await fixture(t), source = input();
  const fences = join(root, 'fences.json'), journal = join(root, 'journal.json'), candidate = join(root, 'candidate.json');
  const original = JSON.stringify(source.journal);
  await writeFile(fences, JSON.stringify(source.fences)); await writeFile(journal, original);
  const args = [new URL('../../../../scripts/migrate-lifecycle-history.mjs', import.meta.url).pathname, '--fences', fences, '--journal', journal];
  let result = spawnSync(process.execPath, args, {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).mode, 'dry-run');
  assert.deepEqual(JSON.parse(result.stdout).coverage, {owners: false, eventFiles: 0});
  assert.equal(JSON.parse(result.stdout).journal, undefined);
  result = spawnSync(process.execPath, [...args, '--output', candidate], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(spawnSync(process.execPath, [...args, '--output', candidate]).status, 0);
  assert.notEqual(spawnSync(process.execPath, [...args, '--output', journal]).status, 0);
  assert.equal(await readFile(journal, 'utf8'), original);
});


test('modern open rows cannot erase historical completion evidence or omit the legacy source', () => {
  const source = input();
  source.journal.conversations[key] = {generation: 0, state: 'open', status: 'act'};
  source.fences.conversations = {};
  source.events = [{id: 'old-completion', kind: 'session.completed', logicalSessionId: key, details: {closeMessageId: '1700000100.000001'}}];
  assert.ok(planLifecycleMigration(source).issues.some(issue => issue.code === 'missing_historical_boundary'));
  source.journal.conversations[key] = {generation: 1, state: 'open', closedThrough: 300, legacyBoundary: closed};
  assert.ok(planLifecycleMigration(source).issues.some(issue => issue.code === 'missing_legacy_source'));
});

test('migration gate rejects missing and unversioned journals before admission or delivery', async t => {
  const root = await fixture(t), runtime = new FinalRuntime({root});
  await assert.rejects(runtime.human(route, {messageId: '1700000200.000001'}), {code: 'ENOENT'});
  await writeFile(join(root, 'final-decisions.json'), JSON.stringify({turns: {}, conversations: {}}));
  await assert.rejects(runtime.human(route, {messageId: '1700000200.000001'}), /migration/);
  assert.throws(() => shouldSuppressConversationDelivery(route, {path: join(root, 'final-decisions.json')}), /migration/);
  await writeFile(join(root, 'final-decisions.json'), JSON.stringify({lifecycleSchemaVersion: 1, turns: {}, conversations: {[key]: null}}));
  await assert.rejects(runtime.human(route, {messageId: '1700000200.000001'}), /migration/);
  assert.throws(() => shouldSuppressConversationDelivery(route, {path: join(root, 'final-decisions.json')}), /migration/);
});
