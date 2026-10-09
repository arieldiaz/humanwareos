import assert from 'node:assert/strict';
import test from 'node:test';
import {allowedModels, applySessionSelection, resolveRequestedModel, switchModelTool} from './switch-model-tool.mjs';

// The shape render-openclaw-runtime-profiles.mjs produces: every allowed model bound to its harness.
const config = {
  agents: {
    defaults: {
      models: {'openai/gpt-5.6-sol': {alias: 'sol', agentRuntime: {id: 'codex'}}, 'anthropic/claude-fable-5-1': {alias: 'fable', agentRuntime: {id: 'claude-cli'}}, 'openai/gpt-5.6-luna': {alias: 'luna'}},
      modelPolicy: {allow: ['openai/gpt-5.6-sol', 'anthropic/claude-fable-5-1']},
    },
    entries: {liv: {models: {'openai/gpt-5.6-sol': {agentRuntime: {id: 'codex'}}, 'anthropic/claude-fable-5-1': {agentRuntime: {id: 'claude-cli'}}}}},
  },
};
const context = {sessionKey: 'agent:liv:slack:channel:c123:thread:1790050400.000001', agentId: 'liv', senderIsOwner: true, assertInvocationCurrent: () => {}};

test('allowed models come from the agent catalog with their aliases and harnesses', () => {
  assert.deepEqual(allowedModels(config, 'LIV'), [
    {ref: 'openai/gpt-5.6-sol', alias: 'sol', harness: 'codex'},
    {ref: 'anthropic/claude-fable-5-1', alias: 'fable', harness: 'claude-cli'},
  ]);
  const models = allowedModels(config, 'liv');
  assert.equal(resolveRequestedModel(models, 'Fable').ref, 'anthropic/claude-fable-5-1');
  assert.equal(resolveRequestedModel(models, 'anthropic/claude-fable-5-1').alias, 'fable');
  assert.equal(resolveRequestedModel(models, 'gpt-5.6-sol').alias, 'sol');
  assert.equal(resolveRequestedModel(models, 'luna'), undefined, 'not in the allow list');
  assert.equal(resolveRequestedModel(models, ''), undefined);
});

test('a prose switch persists the selection the native /model command writes', async () => {
  const applied = [];
  const tool = switchModelTool(context, {config, apply: async selection => {applied.push(selection);}});
  assert.equal(tool.name, 'switch_model');
  assert.match(tool.description, /fable \(anthropic\/claude-fable-5-1\)/);
  const result = await tool.execute('call-1', {model: 'fable', reasoning: 'high'});
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Switched to anthropic\/claude-fable-5-1 on claude-cli, reasoning high/);
  assert.deepEqual(applied, [{config, sessionKey: context.sessionKey, agentId: 'liv', provider: 'anthropic', model: 'claude-fable-5-1', reasoning: 'high'}]);
});

test('unknown models, non-owners and stale invocations are refused without a write', async () => {
  const applied = [];
  const options = {config, apply: async selection => {applied.push(selection);}};
  assert.match((await switchModelTool(context, options).execute('c', {model: 'gemini'})).content[0].text, /Unknown model "gemini"/);
  assert.equal((await switchModelTool({...context, senderIsOwner: false}, options).execute('c', {model: 'sol'})).isError, true);
  assert.equal((await switchModelTool({...context, assertInvocationCurrent: () => { throw new Error('stale'); }}, options).execute('c', {model: 'sol'})).isError, true);
  assert.deepEqual(applied, []);
  assert.equal(switchModelTool({agentId: 'liv'}, options), undefined, 'no session, no tool');
  assert.equal(switchModelTool(context, {config: {}, apply: options.apply}), undefined, 'no catalog, no tool');
});

test('the session entry gets the override fields and loses the stale runtime model', async () => {
  const writes = [];
  const sdk = {
    resolveStorePath: (store, {agentId}) => `/store/${agentId}.json`,
    updateSessionStoreEntry: async ({sessionKey, storePath, update}) => {
      const next = update({sessionId: 's1', model: 'claude-opus-5-5', modelProvider: 'anthropic', contextTokens: 200000, thinkingLevel: 'low'});
      writes.push({sessionKey, storePath, next});
      return next;
    },
  };
  await applySessionSelection({config: {}, sessionKey: context.sessionKey, agentId: 'liv', provider: 'anthropic', model: 'claude-fable-5-1', reasoning: 'high'}, sdk);
  const [{sessionKey, storePath, next}] = writes;
  assert.equal(sessionKey, context.sessionKey);
  assert.equal(storePath, '/store/liv.json');
  assert.equal(next.sessionId, 's1');
  assert.equal(next.providerOverride, 'anthropic');
  assert.equal(next.modelOverride, 'claude-fable-5-1');
  assert.equal(next.modelOverrideSource, 'user');
  assert.equal(next.liveModelSwitchPending, true);
  assert.equal(next.thinkingLevel, 'high');
  assert.equal('model' in next, false);
  assert.equal('contextTokens' in next, false);
  await assert.rejects(applySessionSelection({config: {}, sessionKey: 'agent:liv:main', agentId: 'liv', provider: 'openai', model: 'gpt-5.6-sol'}, {...sdk, updateSessionStoreEntry: async () => null}), /not in the store/);
});
