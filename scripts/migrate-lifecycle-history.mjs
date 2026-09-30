#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {lifecycleDigest} from '../ops/openclaw/plugins/run-signature/lifecycle-reconciliation.mjs';
import {planLifecycleMigration, stageLifecycleMigration} from '../ops/openclaw/plugins/run-signature/lifecycle-migration.mjs';

const {values} = parseArgs({options: {fences: {type: 'string'}, journal: {type: 'string'},
  owners: {type: 'string'}, events: {type: 'string', multiple: true}, output: {type: 'string'}}});
if (!values.fences || !values.journal) throw new Error('Required: --fences FILE --journal FILE. Default: dry-run. --output NEW_FILE stages a candidate only; never installs it.');
const inputs = [];
async function load(path, lines = false) {
  const text = await readFile(path, 'utf8');
  inputs.push({path: resolve(path), digest: lifecycleDigest(text)});
  return lines ? text.split('\n').filter(line => line.trim()).map(JSON.parse) : JSON.parse(text);
}
const plan = planLifecycleMigration({fences: await load(values.fences), journal: await load(values.journal),
  owners: values.owners ? await load(values.owners, true) : [],
  events: (await Promise.all((values.events ?? []).map(path => load(path, true)))).flat()});
async function verifySources() {
  for (const input of inputs) if (lifecycleDigest(await readFile(input.path, 'utf8')) !== input.digest)
    throw new Error(`Source changed during migration planning: ${input.path}`);
}
await verifySources();
if (values.output && inputs.some(input => input.path === resolve(values.output))) throw new Error('Output must not replace an input');
if (values.output && plan.ready) await stageLifecycleMigration(resolve(values.output), plan, {verifySources});
const {journal, reconciliation, ...report} = plan; // Do not echo turn bodies in the operational report.
console.log(JSON.stringify({...report, mode: values.output ? 'stage-candidate' : 'dry-run', inputs,
  coverage: {owners: Boolean(values.owners), eventFiles: values.events?.length ?? 0},
  counts: reconciliation.counts}, null, 2));
process.exitCode = plan.ready ? 0 : 2;
