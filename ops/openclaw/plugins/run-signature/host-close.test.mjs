import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {ThreadLifecycle} from './lifecycle.mjs';
import {formatCloseReport, reportParts, summarizeTrajectory, writeCloseReport, recordSessionClose} from './session-close.mjs';
import {conversationFenceKey} from './conversation-fence.mjs';
import {closeThreadTool, sendThreadMessage} from './index.js';
const manifest = JSON.parse(await readFile(new URL('./openclaw.plugin.json', import.meta.url)));
const route = {channel: 'C123', threadId: '1790050400.000001'};
const input = {messageId: '1790050402.000001', principal: 'UOWNER', accountId: 'max'};
const params = {sessionKey: 'agent:max:slack:channel:c123:thread:1790050400.000001', runId: 'r1'};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'host-close-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const receipts = new Map(), completed = new Set(), files = new Map(), order = [];
  const options = {root,
    record: async () => {}, fault: async () => {},
    snapshot: async close => {order.push('snapshot'); return {report: formatCloseReport({agent: close.accountId}), evidence: close.evidence};},
    writeReport: async close => {order.push('file'); files.set(close.key, close.snapshot.report);},
    send: async close => {order.push('send'); if (!receipts.has(close.key)) receipts.set(close.key, {messageId: 'receipt:' + close.key}); return receipts.get(close.key);},
    completeClose: async close => {order.push('completion'); completed.add(close.key);},
    project: async status => {order.push(status);}};
  return {options, root, receipts, completed, files, order, runtime: new ThreadLifecycle(options)};
}
test('plugin schema accepts the owner principal required by host closure', () => {
  assert.deepEqual(manifest.configSchema.properties.ownerUserId, {type: 'string', pattern: '^U[A-Z0-9]+$'});
});
const toolContext = {messageChannel: 'slack', sessionKey: params.sessionKey, agentAccountId: 'max', requesterSenderId: 'UOWNER'};
const toolOptions = runtime => ({config: {channels: {slack: {accounts: {max: {}}}}}, ownerUserId: 'UOWNER', lifecycle: runtime});
test('owner mixed instruction: the run finishes its work, then the host closes after the run ends', async t => {
  const f = await fixture(t);
  await f.runtime.start(params);
  // "merge this, deploy, then close out this thread": other work happens in the run, then the agent requests close.
  const result = await closeThreadTool(toolContext, toolOptions(f.runtime)).execute();
  assert.equal(result.isError, undefined);
  assert.equal(f.completed.size, 0, 'close never takes effect mid-run');
  await f.runtime.end(params);
  assert.deepEqual(f.order, ['working', 'act', 'snapshot', 'file', 'send', 'completion', 'closed']);
  assert.equal((await f.runtime.state(state => state.conversations[conversationFenceKey(route)])).status, 'closed');
});
test('non-owner close request is refused and nothing closes', async t => {
  const f = await fixture(t);
  await f.runtime.start(params);
  for (const context of [{...toolContext, requesterSenderId: 'UOTHER'}, {...toolContext, requesterSenderId: undefined}]) {
    const result = await closeThreadTool(context, toolOptions(f.runtime)).execute();
    assert.equal(result.isError, true); assert.match(result.content[0].text, /only the owner/);
  }
  assert.equal((await closeThreadTool(toolContext, {...toolOptions(f.runtime), ownerUserId: undefined}).execute()).isError, true);
  assert.equal((await closeThreadTool({...toolContext, agentAccountId: 'other'}, toolOptions(f.runtime)).execute()).isError, true);
  await f.runtime.end(params);
  assert.deepEqual(f.order, ['working', 'act']);
});
test('a close requested by a run interrupted by restart is dropped', async t => {
  const f = await fixture(t);
  await f.runtime.start(params);
  await closeThreadTool(toolContext, toolOptions(f.runtime)).execute();
  await new ThreadLifecycle(f.options).recover();
  await f.runtime.start({...params, runId: 'r2'}); await f.runtime.end({...params, runId: 'r2'});
  assert.equal(f.completed.size, 0);
});
test('no close without a request: an owner run that never calls close_thread ends in act', async t => {
  const f = await fixture(t);
  await f.runtime.start(params); await f.runtime.end(params);
  assert.deepEqual(f.order, ['working', 'act']); assert.equal(f.completed.size, 0);
  assert.equal(closeThreadTool({...toolContext, messageChannel: 'webchat'}, toolOptions(f.runtime)), undefined);
});
for (const accountId of ['liv','max']) test(`${accountId}: duplicate callbacks freeze once and complete after identical file/report`, async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({length: 4}, () => f.runtime.closeCommand(route, {...input, accountId})));
  assert.equal(f.receipts.size, 1); assert.equal(f.completed.size, 1);
  assert.equal(f.files.size, 1);
  assert.deepEqual(f.order, ['snapshot','file','send','completion','closed']);
  const state = JSON.parse(await readFile(join(f.root, 'final-decisions.json')));
  assert.equal(state.conversations[conversationFenceKey(route)].status, 'closed');
  assert.equal(Object.values(state.closes)[0].accountId, accountId);
  assert.equal(Object.values(state.closes)[0].principal, input.principal);
});
for (const boundary of ['snapshot', 'writeReport', 'send', 'completeClose', 'project']) test(`restart at ${boundary} recovers without a model turn or false closure`, async t => {
  const f = await fixture(t);
  const original = f.runtime[boundary];
  f.runtime[boundary] = async (...args) => {if (boundary === 'send' || boundary === 'completeClose') await original(...args); throw new Error('crash');};
  await assert.rejects(f.runtime.closeCommand(route, input), /crash/);
  const state = JSON.parse(await readFile(join(f.root, 'final-decisions.json')));
  assert.notEqual(Object.values(state.closes)[0].phase, 'complete');
  assert.notEqual(state.conversations[conversationFenceKey(route)].status, 'closed');
  await new ThreadLifecycle(f.options).recover();
  assert.equal(f.receipts.size, 1); assert.equal(f.completed.size, 1);
  assert.equal(f.order.at(-1), 'closed');
  await new ThreadLifecycle(f.options).recover();
  assert.equal(f.receipts.size, 1);
});
test('closed is soft: the next admitted run replaces ✅ through ordinary admission and can be closed again', async t => {
  const f = await fixture(t), key = conversationFenceKey(route);
  await f.runtime.closeCommand(route, input);
  assert.equal(f.order.at(-1), 'closed');
  await f.runtime.closeCommand(route, {...input, messageId: '1790050403.000001'});
  assert.equal(f.receipts.size, 1);
  await f.runtime.start({...params, runId: 'r2'});
  await f.runtime.start({...params, runId: 'r2'});
  await f.runtime.end({...params, runId: 'r2'});
  assert.deepEqual(f.order.slice(-2), ['working', 'act']);
  assert.equal((await f.runtime.state(state => state.conversations[key])).status, 'act');
  await f.runtime.closeCommand(route, {...input, messageId: '1790050404.000001'});
  assert.equal(f.order.at(-1), 'closed');
  assert.equal(f.receipts.size, 2); assert.equal(f.completed.size, 2);
});
test('a send the hook suppressed is reported as settled, not retried', async () => {
  const sdk = {buildOutboundSessionContext: value => value, sendDurableMessageBatch: async () => ({status: 'suppressed', payloadOutcomes: [{reason: 'cancelled_by_message_sending_hook'}]})};
  assert.deepEqual(await sendThreadMessage({}, {key: 'k', route, text: 'text'}, sdk), {parts: [], suppressed: ['cancelled_by_message_sending_hook']});
});
test('a run that ends after a close cannot overwrite the closed tile', async t => {
  const f = await fixture(t);
  await f.runtime.start(params);
  await f.runtime.closeCommand(route, input);
  await f.runtime.end(params);
  assert.equal(f.order.at(-1), 'closed');
});
test('a run interrupted by restart restores the prior status', async t => {
  const f = await fixture(t);
  await f.runtime.start(params);
  await f.runtime.end(params);
  await f.runtime.start({...params, runId: 'r2'});
  await new ThreadLifecycle(f.options).recover();
  assert.deepEqual(f.order, ['working', 'act', 'working', 'act']);
  assert.equal((await f.runtime.state(state => Object.values(state.turns).at(-1))).phase, 'failed');
});
test('missing metrics are not zero; partial counters and context are labeled', () => {
  const usage = summarizeTrajectory([{type: 'model.completed', modelId: 'model', data: {usage: {input: 0}}}, {type: 'model.completed', modelId: 'model', data: {usage: {output: 4}}}]);
  const report = formatCloseReport({usage, agent: 'max'});
  assert.match(report, /Fresh input: 0 tokens \(partial: 1\/2/);
  assert.match(report, /Cache read: unavailable/);
  assert.match(report, /Context peak: unavailable/);
  assert.match(report, /Recap evidence is limited/);
  assert.match(report, /Elapsed: unavailable/);
  assert.equal(summarizeTrajectory([{type: 'model.completed', data: {usage: {input: 99}}}], {before: Date.now()}), undefined);
});
test('segmented report retries reuse stable per-part receipts and preserve semantic content', async () => {
  const report = 'A long supported outcome.\n'.repeat(400), receipts = new Map(), sent = [];
  const parts = reportParts(report); assert.equal(parts.join(''), report); assert.ok(parts.length > 1);
  let fail = true;
  const sdk = {buildOutboundSessionContext: value => value, sendDurableMessageBatch: async value => {
    assert.equal(value.requireUnknownSendReconciliation, true);
    if (!receipts.has(value.deliveryIntentId)) {sent.push(value.payloads[0].text); receipts.set(value.deliveryIntentId, {messageId: String(receipts.size)});}
    if (fail && receipts.size === 2) {fail = false; throw new Error('ambiguous receipt');}
    return {status: 'sent', results: [receipts.get(value.deliveryIntentId)]};
  }};
  const turn = {key: 'close:0', closeOperation: 'close:0', accountId: 'max', route, text: report};
  await assert.rejects(sendThreadMessage({}, turn, sdk));
  await sendThreadMessage({}, turn, sdk);
  assert.equal(sent.join(''), report); assert.equal(receipts.size, parts.length);
});
test('completion event is operation-idempotent and matches the already written Markdown', async t => {
  const f = await fixture(t), report = formatCloseReport({agent: 'max'}), operationId = 'close:0';
  const view = await writeCloseReport({dataRoot: f.root, operationId, report});
  const event = {dataRoot: f.root, operationId, report, agent: 'max', channel: route.channel, thread: route.threadId, closeMessageId: 'receipt', now: new Date('2026-09-30T12:00:00Z')};
  await recordSessionClose(event); await recordSessionClose(event);
  assert.equal(await readFile(view, 'utf8'), report + '\n');
  assert.equal((await readFile(join(f.root, 'evidence/sessions/events/2026-09-30.jsonl'), 'utf8')).trim().split('\n').length, 1);
});

test('expired uncertain close receipt stops for reconciliation', async t => {
  const f = await fixture(t);
  f.runtime.send = async () => {throw new Error('unknown');};
  await assert.rejects(f.runtime.closeCommand(route, input));
  await f.runtime.state(state => {Object.values(state.closes)[0].sendStartedAt = Date.now() - 86400001;});
  await new ThreadLifecycle(f.options).recover();
  assert.equal(f.receipts.size, 0);
  assert.equal((await f.runtime.state(state => Object.values(state.closes)[0])).phase, 'sending');
  assert.notEqual((await f.runtime.state(state => state.conversations[conversationFenceKey(route)])).status, 'closed');
});
for (const phase of ['reserved', 'snapshot', 'file', 'sending', 'delivered', 'recorded', 'complete']) test(`failed journal persistence at ${phase} replays the same operation safely`, async t => {
  const f = await fixture(t), base = f.runtime.state.bind(f.runtime);
  let interrupted = false;
  f.runtime.state = operation => base(async state => {
    const result = await operation(state);
    if (!interrupted && Object.values(state.closes ?? {}).some(close => close.phase === phase)) {
      interrupted = true; throw new Error('journal persistence failed');
    }
    return result;
  });
  await assert.rejects(f.runtime.closeCommand(route, input), /persistence/);
  const restarted = new ThreadLifecycle(f.options);
  // A request whose reservation never committed is repeated by the caller.
  // Once reserved, startup recovery needs no inbound/model turn.
  if (phase === 'reserved') await restarted.closeCommand(route, input);
  else await restarted.recover();
  assert.equal(f.receipts.size, 1); assert.equal(f.completed.size, 1);
  assert.equal((await restarted.state(state => state.conversations[conversationFenceKey(route)])).status, 'closed');
});

