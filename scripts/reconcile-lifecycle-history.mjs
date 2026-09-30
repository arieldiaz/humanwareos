#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {reconcileLifecycleHistory, lifecycleDigest} from '../ops/openclaw/plugins/run-signature/lifecycle-reconciliation.mjs';

const {values} = parseArgs({options: {
  fences: {type: 'string'}, journal: {type: 'string'}, owners: {type: 'string'},
  events: {type: 'string', multiple: true},
}});
if (!values.fences || !values.journal) throw new Error('Required: --fences FILE --journal FILE; optional: --owners JSONL --events JSONL (repeatable). No writes are performed.');
const inputs = [];
async function load(path, lines = false) {
  const text = await readFile(path, 'utf8'); // Missing or malformed input must not become an empty store.
  inputs.push({path, digest: lifecycleDigest(text)});
  return lines ? text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line)) : JSON.parse(text);
}
const report = reconcileLifecycleHistory({
  fences: await load(values.fences), journal: await load(values.journal),
  owners: values.owners ? await load(values.owners, true) : [],
  events: (await Promise.all((values.events ?? []).map(path => load(path, true)))).flat(),
});
// Detect concurrent source changes; a live observation is still not a quiescent migration plan.
for (const input of inputs) {
  if (lifecycleDigest(await readFile(input.path, 'utf8')) !== input.digest)
    throw new Error(`Source changed during reconciliation: ${input.path}`);
}
// Paths and identifiers belong in the private operational report, never a public artifact.
console.log(JSON.stringify({...report, inputs: inputs.sort((a, b) => a.path.localeCompare(b.path)),
  coverage: {owners: Boolean(values.owners), eventFiles: values.events?.length ?? 0}}, null, 2));
process.exitCode = report.consistent ? 0 : 2;
