import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {retireSlackCloseBoundary, retireFinalBoundary} from './patch-2026.9.1-retired-edits.mjs';

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
test('retires both installed owner-close intercept shapes to stock admission', async () => {
  const stock = 'async function prepare(message, account) { const authorization = {senderId: message.user};\n\tconst { senderId, allowFromLower } = authorization;\n return "admitted"; }';
  const anchor = '\tconst { senderId, allowFromLower } = authorization;';
  const open = `${anchor}\n\t// humanware:owner-close-before-admission\n\tconst closeOwner = ${OWNER};\n\tif (closeOwner?.slackClose && await closeOwner.slackClose({message, accountId: account.accountId})) return null;`;
  const failClosed = `${anchor}\n\t// humanware:owner-close-before-admission\n\tconst closeOwner = ${OWNER};\n\tif (!closeOwner?.slackClose) throw new Error("Host closure owner is unavailable");\n\tif (await closeOwner.slackClose({message, accountId: account.accountId})) return null;`;
  for (const installed of [stock.replace(anchor, open), stock.replace(anchor, failClosed)]) {
    const retired = retireSlackCloseBoundary(installed);
    assert.equal(retired, stock);
    const context = vm.createContext({Symbol});
    vm.runInContext(retired, context);
    assert.equal(await context.prepare({user: 'UOWNER', text: 'close this'}, {accountId: 'max'}), 'admitted');
  }
  assert.equal(retireSlackCloseBoundary(stock), stock);
  assert.throws(() => retireSlackCloseBoundary(stock.replace(anchor, `${anchor}\n\t// humanware:owner-close-before-admission\n\tchanged();`)), /Unrecognized/);
});
