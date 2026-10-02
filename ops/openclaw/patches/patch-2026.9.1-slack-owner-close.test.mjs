import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {patchSlackCloseBoundary, retireFinalBoundary} from './patch-2026.9.1-slack-owner-close.mjs';

const OWNER = 'globalThis[Symbol.for("humanware.final-envelope.v1")]';
const installed = {
  cursor: [
    'function runCliAgent(paramsInput) { return paramsInput; }',
    `// humanware:final-envelope-cursor\nfunction runCliAgent(paramsInput) {\n const runtime = ${OWNER};\n if (!runtime && /:slack:channel:/i.test(paramsInput.sessionKey ?? "")) throw new Error("Lifecycle final owner is unavailable");\n return runtime ? runtime.run(paramsInput, runCliAgentUncontracted, "cursor") : runCliAgentUncontracted(paramsInput);\n}\nfunction runCliAgentUncontracted(paramsInput) { return paramsInput; }`,
  ],
  codex: [
    'async function runAgentHarnessAttempt(params) {\n\treturn runSelectedAgentHarnessAttempt(params);\n}',
    `// humanware:final-envelope-codex\nasync function runAgentHarnessAttempt(params) {\n const runtime = ${OWNER};\n if (!runtime && /:slack:channel:/i.test(params.sessionKey ?? "")) throw new Error("Lifecycle final owner is unavailable");\n return runtime ? runtime.run(params, runSelectedAgentHarnessAttempt, "codex") : runSelectedAgentHarnessAttempt(params);\n}`,
  ],
  schema: [
    'function start() {\n\t\tcodexModelCallDiagnostics.setRequestPayloadBytes(utf8JsonByteLength(turnStartParams));\n}',
    `function start() {\n\t\t// humanware:final-envelope-schema\n\t\tconst finalSchema = ${OWNER}?.schema(runtimeParams);\n\t\tif (finalSchema) turnStartParams.outputSchema = finalSchema;\n\t\tcodexModelCallDiagnostics.setRequestPayloadBytes(utf8JsonByteLength(turnStartParams));\n}`,
  ],
};

for (const [kind, [stock, edited]] of Object.entries(installed)) test(`retires the installed ${kind} final edit to stock text`, () => {
  assert.equal(retireFinalBoundary(edited, kind), stock);
  assert.equal(retireFinalBoundary(stock, kind), stock);
});
test('an unrecognized final-envelope edit fails closed', () => {
  assert.throws(() => retireFinalBoundary('// humanware:final-envelope-cursor\nchanged', 'cursor'), /Unrecognized/);
});
test('raw owner intercept precedes mention stripping/admission; no owner falls through to stock handling', async () => {
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
