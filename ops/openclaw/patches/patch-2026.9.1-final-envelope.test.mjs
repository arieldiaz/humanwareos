import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {patchFinalBoundary} from './patch-2026.9.1-final-envelope.mjs';

for (const kind of ['cursor', 'codex']) test(`${kind} boundary executes the shared owner and is idempotent`, async () => {
  const source = kind === 'cursor' ? 'function runCliAgent(paramsInput) { return paramsInput; }' :
    'async function runAgentHarnessAttempt(params) {\n\treturn runSelectedAgentHarnessAttempt(params);\n}\nfunction runSelectedAgentHarnessAttempt(params) { return params; }';
  const patched = patchFinalBoundary(source, kind);
  assert.equal(patchFinalBoundary(patched, kind), patched);
  const calls = [];
  const context = vm.createContext({Symbol});
  context[Symbol.for('humanware.final-envelope.v1')] = {run: async (params, execute, actualKind) => {calls.push(actualKind); return execute({...params, verified: true});}};
  vm.runInContext(patched, context);
  const result = await (kind === 'cursor' ? context.runCliAgent : context.runAgentHarnessAttempt)({runId: 'r'});
  assert.equal(result.verified, true);
  assert.deepEqual(calls, [kind]);
});
test('Codex passes schema through the actual turn/start parameter boundary', () => {
  const source = 'function start() { const turnStartParams = {};\n\t\tcodexModelCallDiagnostics.setRequestPayloadBytes(utf8JsonByteLength(turnStartParams));\nreturn turnStartParams; }';
  const context = vm.createContext({Symbol, runtimeParams: {sessionKey: 'test'}, codexModelCallDiagnostics: {setRequestPayloadBytes() {}}, utf8JsonByteLength: () => 1});
  context[Symbol.for('humanware.final-envelope.v1')] = {schema: () => ({type: 'object'})};
  vm.runInContext(patchFinalBoundary(source, 'schema'), context);
  assert.equal(context.start().outputSchema.type, 'object');
});
test('changed installed anchors fail closed', () => {
  for (const kind of ['cursor','codex','schema']) assert.throws(() => patchFinalBoundary('different source', kind));
});
test('Slack cannot silently bypass a missing final owner', async () => {
  const context = vm.createContext({Symbol});
  vm.runInContext(patchFinalBoundary('function runCliAgent(paramsInput) { return paramsInput; }', 'cursor'), context);
  assert.throws(() => context.runCliAgent({sessionKey: 'agent:max:slack:channel:c123:thread:1'}), /owner is unavailable/);
});
