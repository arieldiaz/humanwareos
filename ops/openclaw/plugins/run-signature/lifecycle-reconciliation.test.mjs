import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {canonicalLifecycleKey, reconcileLifecycleHistory} from './lifecycle-reconciliation.mjs';

const key = 'slack:C123:1700000000.000001';
const messageId = '1700000100.000001';
const closed = {state: 'closed', revision: 3, openedAt: 100, updatedAt: 300, closedAt: 300, closedThrough: 300, closeMessageId: messageId};
function fixture(fence = closed, status = 'closed') {
  return {fences: {schemaVersion: 1, conversations: {[key]: structuredClone(fence)}},
    journal: {turns: {}, conversations: {[key]: {status}}}, owners: [], events: []};
}
const codes = report => report.issues.map(issue => issue.code);
const completion = (id = 'completed-1') => ({id, kind: 'session.completed', logicalSessionId: key, details: {closeMessageId: messageId}});

test('reconciliation preserves closed and reopened boundaries without inventing generations', () => {
  const input = fixture();
  const original = structuredClone(input);
  const first = reconcileLifecycleHistory(input);
  assert.equal(first.consistent, true);
  assert.deepEqual(input, original);
  const boundary = first.conversations[0].boundary;
  assert.equal(boundary.closedThrough, 300);
  assert.equal(boundary.generation, null);
  const reopened = fixture({...closed, state: 'open', revision: 4, updatedAt: 400, reopenedAt: 400, reopenedByMessageId: 'human-reopen'}, 'act');
  const next = reconcileLifecycleHistory(reopened);
  assert.equal(next.consistent, true);
  assert.equal(next.conversations[0].boundary.id, boundary.id);
  assert.equal(next.conversations[0].legacyFence.state, 'open');
  assert.deepEqual(reconcileLifecycleHistory(reopened), next);
});

test('fresh open conversations have no fabricated closed boundary', () => {
  const report = reconcileLifecycleHistory(fixture({state: 'open', revision: 1, openedAt: 100, updatedAt: 100}, 'scheduled'));
  assert.equal(report.consistent, true);
  assert.equal(report.conversations[0].boundary, undefined);
});

test('duplicate history deduplicates only identical event ids; conflicting contents stop review', () => {
  const input = fixture();
  input.events = [completion(), completion()];
  let report = reconcileLifecycleHistory(input);
  assert.equal(report.consistent, true);
  assert.equal(report.counts.duplicateEvents, 1);
  assert.equal(report.conversations[0].closedEvents.length, 1);
  input.events.push({...completion(), details: {closeMessageId: 'different'}});
  report = reconcileLifecycleHistory(input);
  assert.equal(report.consistent, false);
  assert.ok(codes(report).includes('conflicting_event_id'));
});

test('canonical keys unify identities and case, but aliases never overwrite history', () => {
  assert.equal(canonicalLifecycleKey('agent:liv:slack:channel:c123:thread:1700000000.000001'), key);
  assert.equal(canonicalLifecycleKey('slack:c123:1700000000.000001'), key);
  assert.equal(canonicalLifecycleKey('slack:C123:1700000000'), undefined);
  const input = fixture();
  input.fences.conversations[key.toLowerCase()] = {...closed, closedThrough: 290};
  const report = reconcileLifecycleHistory(input);
  assert.equal(report.consistent, false);
  assert.ok(codes(report).includes('duplicate_fence_mapping'));
});

test('closing, unproven reopen, missing boundary and competing status remain explicit discrepancies', () => {
  for (const [input, expected] of [
    [fixture({...closed, state: 'closing', closeToken: 'legacy-token'}), 'unresolved_close'],
    [fixture({...closed, state: 'open'}, 'act'), 'unproven_reopen'],
    [fixture({...closed, closedThrough: undefined}), 'incomplete_closed_boundary'],
    [fixture(closed, 'act'), 'state_disagreement'],
    [fixture({...closed, closedThrough: 400}), 'boundary_after_update'],
  ]) {
    const report = reconcileLifecycleHistory(input);
    assert.equal(report.consistent, false);
    assert.ok(codes(report).includes(expected), JSON.stringify(report.issues));
  }
});

test('orphan completion does not manufacture closed state or a report resend', () => {
  const input = fixture();
  input.fences.conversations = {};
  input.journal.conversations = {};
  input.events = [completion()];
  const report = reconcileLifecycleHistory(input);
  assert.ok(codes(report).includes('orphan_closure'));
  assert.equal(report.conversations[0].boundary, undefined);
  assert.equal(report.conversations[0].legacyFence, undefined);
});

test('pending historical model closure and mismatched route require reconciliation', () => {
  const input = fixture();
  const turnKey = `${key}:run-1`;
  input.journal.turns[turnKey] = {key: turnKey, conversation: key, phase: 'queued',
    envelope: {status: 'closed'}, route: {channel: 'C999', threadId: '1700000000.000001'}};
  const report = reconcileLifecycleHistory(input);
  assert.ok(codes(report).includes('pending_historical_close'));
  assert.ok(codes(report).includes('turn_route_mismatch'));
});

test('sender routing is retained separately from lifecycle status and append order wins', () => {
  const input = fixture();
  input.owners = [{key: key.toLowerCase(), owner: 'liv'}, {key, owner: 'max'}];
  const report = reconcileLifecycleHistory(input);
  assert.equal(report.consistent, true);
  assert.equal(report.conversations[0].sender, 'max');
  assert.equal(report.conversations[0].journal.status, 'closed');
});

test('unknown schemas and malformed objects fail closed instead of treating stores as empty', () => {
  for (const fences of [null, {schemaVersion: 2, conversations: {}}, {schemaVersion: 1, conversations: []}]) {
    assert.ok(codes(reconcileLifecycleHistory({...fixture(), fences})).includes('invalid_fence_snapshot'));
  }
  assert.ok(codes(reconcileLifecycleHistory({...fixture(), journal: null})).includes('invalid_journal'));
});

test('CLI is repeatable, read-only and errors on malformed or absent source files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lifecycle-reconciliation-'));
  try {
    const input = fixture();
    const fencesPath = join(root, 'fences.json'), journalPath = join(root, 'journal.json');
    const fenceText = JSON.stringify(input.fences), journalText = JSON.stringify(input.journal);
    await writeFile(fencesPath, fenceText);
    await writeFile(journalPath, journalText);
    const cli = new URL('../../../../scripts/migrate-lifecycle-history.mjs', import.meta.url);
    const args = [cli.pathname, '--fences', fencesPath, '--journal', journalPath];
    const first = spawnSync(process.execPath, args, {encoding: 'utf8'});
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).mode, 'dry-run');
    assert.equal(spawnSync(process.execPath, args, {encoding: 'utf8'}).stdout, first.stdout);
    assert.equal(await readFile(fencesPath, 'utf8'), fenceText);
    assert.equal(await readFile(journalPath, 'utf8'), journalText);
    await writeFile(fencesPath, '{');
    assert.notEqual(spawnSync(process.execPath, args).status, 0);
    await rm(fencesPath);
    assert.notEqual(spawnSync(process.execPath, args).status, 0);
  } finally { await rm(root, {recursive: true, force: true}); }
});


test('completion evidence without a preserved fence cannot silently validate an open mapping', () => {
  const input = fixture({state: 'open', revision: 1, openedAt: 100, updatedAt: 100}, 'act');
  input.events = [completion()];
  const report = reconcileLifecycleHistory(input);
  assert.ok(codes(report).includes('missing_historical_boundary'));
  assert.equal(report.applySupported, false);
  input.events[0].details = {};
  assert.ok(codes(reconcileLifecycleHistory(input)).includes('unmapped_completion'));
});


test('an ordinary orphan turn cannot pass reconciliation even with a legacy fence', () => {
  for (const withFence of [true, false]) {
    const input = fixture({state: 'open', revision: 1, openedAt: 100, updatedAt: 100}, 'act');
    input.journal.conversations = {};
    if (!withFence) input.fences.conversations = {};
    const turnKey = `${key}:orphan`;
    input.journal.turns[turnKey] = {key: turnKey, conversation: key, phase: 'queued',
      envelope: {status: 'act', message: 'unmapped result'}, startedAt: 200};
    const original = structuredClone(input);
    const report = reconcileLifecycleHistory(input);
    assert.equal(report.consistent, false);
    assert.ok(codes(report).includes('orphan_turn'));
    assert.deepEqual(input, original);
    assert.equal(report.conversations[0].journal, undefined);
  }
});
