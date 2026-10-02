import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {patchSlackCloseBoundary} from '../../patches/patch-2026.9.1-slack-owner-close.mjs';
import plugin from './index.js';

// The close edit installed in OpenClaw 2026.9.1 calls this plugin; ordinary
// messages must still reach model admission.
plugin.register({config: {channels: {slack: {accounts: {max: {}}}}}, pluginConfig: {ownerUserId: 'UOWNER'}, on() {}});
const owner = globalThis[Symbol.for('humanware.final-envelope.v1')];

test('installed fail-closed Slack boundary finds the close owner and admits ordinary messages', async () => {
  const source = 'async function prepare(message, account) { const authorization = {senderId: message.user};\n\tconst { senderId, allowFromLower } = authorization;\n return "admitted"; }';
  const installed = patchSlackCloseBoundary(source).replace('if (closeOwner?.slackClose && await closeOwner.slackClose(', 'if (!closeOwner?.slackClose) throw new Error("Host closure owner is unavailable");\n\tif (await closeOwner.slackClose(');
  const context = vm.createContext({Symbol});
  context[Symbol.for('humanware.final-envelope.v1')] = owner;
  vm.runInContext(installed, context);
  assert.equal(await context.prepare({channel: 'C123', ts: '1.1', thread_ts: '1.0', user: 'UOTHER', text: 'hello'}, {accountId: 'max'}), 'admitted');
});
