import {open, readFile, link, unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {reconcileLifecycleHistory, lifecycleDigest} from './lifecycle-reconciliation.mjs';

// Offline only: no runtime, sender, event writer or production-install hook.
export function planLifecycleMigration(input) {
  const reconciliation = reconcileLifecycleHistory(input);
  const issues = [...reconciliation.issues];
  const journal = structuredClone(input.journal);
  const fencesDigest = lifecycleDigest(input.fences);
  if (journal?.lifecycleSchemaVersion === 1 && journal.lifecycleMigration?.fencesDigest !== fencesDigest)
    issues.push({code: 'migration_source_changed', source: 'fences'});
  if (issues.length) return {ready: false, issues, reconciliation};
  let imported = 0, alreadyVersioned = 0;
  for (const record of reconciliation.conversations) {
    if (!record.journal && !record.legacyFence) continue; // Routing/evidence is not a lifecycle owner.
    if (record.journal?.generation !== undefined) { alreadyVersioned++; continue; }
    const legacy = record.legacyFence;
    journal.conversations[record.conversation] = {...record.journal, ...legacy, generation: 0,
      state: legacy?.state ?? 'open', reconciliationRequired: false,
      ...(legacy ? {legacyBoundary: structuredClone(legacy)} : {})};
    imported++;
  }
  const counts = state => ({conversations: Object.keys(state.conversations).length,
    turns: Object.keys(state.turns).length, closes: Object.keys(state.closes ?? {}).length,
    closed: Object.values(state.conversations).filter(value => (value.state ?? value.status) === 'closed').length});
  const before = counts(input.journal), after = counts(journal);
  journal.lifecycleSchemaVersion = 1;
  journal.lifecycleMigration ??= {fencesDigest, sourceJournalDigest: lifecycleDigest(input.journal),
    sourceDigest: reconciliation.sourceDigest, before, after};
  const parity = reconcileLifecycleHistory({...input, journal});
  if (!parity.consistent) return {ready: false, issues: parity.issues, reconciliation};
  // Baseline 0 is not a historical generation count. Turns/closes/reports remain intact.
  return {ready: true, issues: [], reconciliation, before, after, imported, alreadyVersioned,
    noOp: lifecycleDigest(journal) === lifecycleDigest(input.journal),
    outputDigest: lifecycleDigest(journal), journal};
}

// Atomically publish a *new candidate*, never replace an input or installed journal.
// The operator installs it only during separately approved, quiesced cutover.
export async function stageLifecycleMigration(path, plan, {verifySources = async () => {}, fault = async () => {}} = {}) {
  if (!plan.ready) throw new Error('Lifecycle reconciliation has discrepancies');
  const text = JSON.stringify(plan.journal) + '\n';
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await fault('before-write');
    const file = await open(tmp, 'wx', 0o600);
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await verifySources();
    await fault('before-publish');
    try { await link(tmp, path); }
    catch (error) {
      if (error.code !== 'EEXIST' || await readFile(path, 'utf8') !== text) throw error;
    }
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    await fault('after-publish');
  } finally {
    try { await unlink(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return {path, outputDigest: plan.outputDigest};
}
