import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {conversationFenceKey, readConversationFence, isHumanSlackUserProfile, shouldSuppressConversationDelivery} from './conversation-fence.mjs';
const route = {channel: 'C123', threadId: '1790050400.000001'};
test('canonical route and verified human profile', () => {
  assert.equal(conversationFenceKey({sessionKey: 'agent:max:slack:channel:c123:thread:1790050400.000001'}), 'slack:C123:1790050400.000001');
  assert.equal(isHumanSlackUserProfile({id: 'UHUMAN'}), true);
  for (const user of [undefined, {id: 'UBOT', is_bot: true}, {id: 'UAPP', is_app_user: true}]) assert.equal(isHumanSlackUserProfile(user), false);
});
test('only the migrated journal is read; legacy cannot override it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fence-reader-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const paths = {path: join(root, 'final-decisions.json'), legacyPath: join(root, 'conversation-fences.json')};
  const key = conversationFenceKey(route);
  await writeFile(paths.legacyPath, JSON.stringify({schemaVersion: 1, conversations: {[key]: {state: 'closed', closedThrough: 100}}}));
  assert.throws(() => readConversationFence(route, paths), {code: 'ENOENT'});
  await writeFile(paths.path, JSON.stringify({turns: {}, conversations: {}}));
  assert.throws(() => readConversationFence(route, paths), /migration/);
  await writeFile(paths.path, JSON.stringify({lifecycleSchemaVersion: 1, turns: {}, conversations: {[key]: {generation: 1, state: 'open', closedThrough: 100}}}));
  assert.equal(shouldSuppressConversationDelivery(route, {...paths, workCreatedAt: 99}), true);
  assert.equal(shouldSuppressConversationDelivery(route, {...paths, workCreatedAt: 101}), false);
  assert.equal(shouldSuppressConversationDelivery(route, paths), true);
  await writeFile(paths.path, JSON.stringify({lifecycleSchemaVersion: 1, turns: {}, conversations: {[key]: {generation: 1, state: 'closing'}}}));
  assert.equal(shouldSuppressConversationDelivery(route, {...paths, workCreatedAt: 101}), true);
});
