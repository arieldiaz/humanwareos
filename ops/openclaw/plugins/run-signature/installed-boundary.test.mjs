import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {patchFinalBoundary, patchSlackCloseBoundary} from '../../patches/patch-2026.9.1-final-envelope.mjs';
import plugin from './index.js';

// The edits already installed in OpenClaw 2026.9.1 call this plugin; plain text
// and NO_REPLY must pass through them unchanged.
plugin.register({config: {channels: {slack: {accounts: {max: {}}}}}, pluginConfig: {ownerUserId: 'UOWNER'}, on() {}});
const owner = globalThis[Symbol.for('humanware.final-envelope.v1')];
const sessionKey = 'agent:max:slack:channel:c123:thread:1790050400.000001';

for (const [kind, source, entry] of [
  ['cursor', 'function runCliAgent(paramsInput) { return {payloads: [{text: paramsInput.reply}]}; }', 'runCliAgent'],
  ['codex', 'async function runAgentHarnessAttempt(params) {\n\treturn runSelectedAgentHarnessAttempt(params);\n}\nfunction runSelectedAgentHarnessAttempt(params) { return {assistantTexts: [params.reply]}; }', 'runAgentHarnessAttempt'],
]) test(`installed ${kind} boundary passes plain text and NO_REPLY through`, async () => {
  const context = vm.createContext({Symbol});
  context[Symbol.for('humanware.final-envelope.v1')] = owner;
  vm.runInContext(patchFinalBoundary(source, kind), context);
  for (const reply of ['A plain answer.', 'NO_REPLY']) {
    const result = await context[entry]({sessionKey, runId: 'r1', prompt: 'hi', reply});
    assert.equal(JSON.stringify(result).includes(reply), true);
    assert.equal(JSON.stringify(result).includes('schemaVersion'), false);
  }
});
test('installed Codex turn/start boundary attaches no output schema', () => {
  const source = 'function start() { const turnStartParams = {};\n\t\tcodexModelCallDiagnostics.setRequestPayloadBytes(utf8JsonByteLength(turnStartParams));\nreturn turnStartParams; }';
  const context = vm.createContext({Symbol, runtimeParams: {sessionKey}, codexModelCallDiagnostics: {setRequestPayloadBytes() {}}, utf8JsonByteLength: () => 1});
  context[Symbol.for('humanware.final-envelope.v1')] = owner;
  vm.runInContext(patchFinalBoundary(source, 'schema'), context);
  assert.equal(context.start().outputSchema, undefined);
});
test('installed fail-closed Slack boundary finds the close owner and admits ordinary messages', async () => {
  const source = 'async function prepare(message, account) { const authorization = {senderId: message.user};\n\tconst { senderId, allowFromLower } = authorization;\n return "admitted"; }';
  const installed = patchSlackCloseBoundary(source).replace('if (closeOwner?.slackClose && await closeOwner.slackClose(', 'if (!closeOwner?.slackClose) throw new Error("Host closure owner is unavailable");\n\tif (await closeOwner.slackClose(');
  const context = vm.createContext({Symbol});
  context[Symbol.for('humanware.final-envelope.v1')] = owner;
  vm.runInContext(installed, context);
  assert.equal(await context.prepare({channel: 'C123', ts: '1.1', thread_ts: '1.0', user: 'UOTHER', text: 'hello'}, {accountId: 'max'}), 'admitted');
});
