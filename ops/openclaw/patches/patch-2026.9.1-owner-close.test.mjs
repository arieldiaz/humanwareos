import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {patchSlackCloseBoundary} from './patch-2026.9.1-owner-close.mjs';

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
