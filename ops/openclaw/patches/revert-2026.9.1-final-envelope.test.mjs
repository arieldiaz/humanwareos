import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {BOUNDARIES, revertBoundary, revertFinalBoundaries} from './revert-2026.9.1-final-envelope.mjs';

for (const kind of Object.keys(BOUNDARIES)) test(`${kind}: retired edit reverts to stock and stock is unchanged`, () => {
  const [stock, edited] = BOUNDARIES[kind];
  assert.equal(revertBoundary(`a\n${edited}\nb`, kind), `a\n${stock}\nb`);
  assert.equal(revertBoundary(`a\n${stock}\nb`, kind), `a\n${stock}\nb`);
  assert.throws(() => revertBoundary('changed', kind), /neither stock/);
  assert.throws(() => revertBoundary(`// humanware:final-envelope-${kind}\n${stock}`, kind), /neither stock/);
});

test('reverts copied bundles in place and is idempotent', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'revert-final-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const core = path.join(root, 'core'), codex = path.join(root, 'codex');
  fs.mkdirSync(core); fs.mkdirSync(codex);
  fs.writeFileSync(path.join(core, 'cli-runner-A.js'), BOUNDARIES.cursor[1]);
  fs.writeFileSync(path.join(core, 'selection-A.js'), BOUNDARIES.codex[1]);
  fs.writeFileSync(path.join(codex, 'run-attempt-A.js'), BOUNDARIES.schema[1]);
  assert.deepEqual(revertFinalBoundaries(core, codex), {reverted: 3, checked: 3});
  assert.deepEqual(revertFinalBoundaries(core, codex), {reverted: 0, checked: 3});
  assert.equal(fs.readFileSync(path.join(codex, 'run-attempt-A.js'), 'utf8'), BOUNDARIES.schema[0]);
});
