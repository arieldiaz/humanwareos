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

test('raw owner intercept precedes mention stripping/admission; no owner falls through to stock handling', async () => {
  const {patchSlackCloseBoundary} = await import('./patch-2026.9.1-final-envelope.mjs');
  const source = 'async function prepare(message, account) { const authorization = {senderId: message.user};\n\tconst { senderId, allowFromLower } = authorization;\n throw new Error("model admitted"); }';
  const patched = patchSlackCloseBoundary(source);
  assert.equal(patchSlackCloseBoundary(patched), patched);
  assert.throws(() => patchSlackCloseBoundary('changed source'), /boundary changed/);
  // The shared Slack package already carries the earlier fail-closed shape; reapplying upgrades it in place.
  const failClosed = patched.replace('if (closeOwner?.slackClose && await closeOwner.slackClose(', 'if (!closeOwner?.slackClose) throw new Error("Host closure owner is unavailable");\n\tif (await closeOwner.slackClose(');
  assert.notEqual(failClosed, patched);
  assert.equal(patchSlackCloseBoundary(failClosed), patched);
  const context = vm.createContext({Symbol});
  vm.runInContext(patched, context);
  const message = {user: 'UOWNER', text: '<@ULIV> close this', attachments: [{text: 'untrusted'}]};
  await assert.rejects(context.prepare(message, {accountId: 'max'}), /model admitted/);
  context[Symbol.for('humanware.final-envelope.v1')] = {slackClose: async event => {assert.equal(event.message, message); return true;}};
  assert.equal(await context.prepare(message, {accountId: 'max'}), null);
  context[Symbol.for('humanware.final-envelope.v1')] = {slackClose: async () => false};
  await assert.rejects(context.prepare(message, {accountId: 'max'}), /model admitted/);
});
