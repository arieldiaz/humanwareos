import assert from 'node:assert/strict';
import test from 'node:test';
import {registerThreadLead} from './thread-lead.mjs';

function claim(overrides = {}) {
  const hooks = new Map();
  registerThreadLead({pluginConfig: {defaultSlackAccount: 'liv'}, on: (name, fn) => hooks.set(name, fn)}, {
    isExcludedChannel: channel => channel === 'CGUEST',
    botUserIds: async () => new Set(['ULIV', 'UMAX']),
    ...overrides,
  });
  const inbound = hooks.get('inbound_claim');
  return (event, ctx = {}) => inbound({channel: 'slack', conversationId: 'channel:C123', threadId: '1790050400.000001', senderId: 'UOWNER', ...event}, ctx);
}

test('the default answers an unaddressed thread and the other identity stays quiet', async () => {
  const inbound = claim();
  assert.equal(await inbound({accountId: 'liv'}), undefined);
  assert.deepEqual(await inbound({accountId: 'max'}), {handled: true});
});

test('a deliberate mention switches the lead for later turns', async () => {
  const inbound = claim();
  assert.equal(await inbound({accountId: 'max', wasMentioned: true}), undefined);
  assert.deepEqual(await inbound({accountId: 'liv'}), {handled: true});
  assert.equal(await inbound({accountId: 'max'}), undefined);
});

test('agent-authored messages, including the close report, never trigger a run', async () => {
  const inbound = claim();
  assert.deepEqual(await inbound({accountId: 'liv', senderId: 'UMAX'}), {handled: true});
  assert.deepEqual(await inbound({accountId: 'max', senderId: 'ULIV'}), {handled: true});
});

test('other channels, guest channels and unknown routes are left to the host', async () => {
  const inbound = claim();
  assert.equal(await inbound({channel: 'discord', accountId: 'max'}), undefined);
  assert.equal(await inbound({conversationId: 'channel:CGUEST', accountId: 'max'}), undefined);
  assert.equal(await inbound({threadId: undefined, messageId: 'not-a-ts', accountId: 'max'}), undefined);
});
