import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {ThreadLifecycle} from './lifecycle.mjs';
import {formatCloseReport, reportParts, summarizeTrajectory, writeCloseReport, recordSessionClose} from './close-report.mjs';
import {closeThreadTool, loadSlackThreadSnapshot, rootShowsClosed, sendThreadMessage, shouldClaimClosedBotInbound} from './host-close.mjs';
const manifest = JSON.parse(await readFile(new URL('./openclaw.plugin.json', import.meta.url)));
const route = {channel: 'C123', threadId: '1790050400.000001'};
const input = 'max';
const params = {sessionKey: 'agent:max:slack:channel:c123:thread:1790050400.000001', runId: 'r1'};
// Stubbed Slack: the root's reactions are the only lifecycle record.
function fixture() {
  const receipts = new Map(), completed = new Set(), files = new Map(), order = [], root = [];
  const options = {
    record: async () => {},
    closed: async () => rootShowsClosed(root, new Set(['UMAX'])),
    snapshot: async close => {order.push('snapshot'); return {report: formatCloseReport({agent: close.accountId}), evidence: close.evidence};},
    writeReport: async close => {order.push('file'); files.set(close.key, close.snapshot.report);},
    send: async close => {order.push('send'); receipts.set(close.key, true);},
    completeClose: async close => {order.push('completion'); completed.add(close.key);},
    project: async status => {order.push(status); root.splice(0, root.length, {name: {working: 'arrows_counterclockwise', act: 'raised_hand', closed: 'white_check_mark'}[status], users: ['UMAX']});}};
  return {options, root, receipts, completed, files, order, runtime: new ThreadLifecycle(options)};
}
test('plugin schema rejects retired owner closure keys', () => {
  assert.equal(manifest.configSchema.properties.ownerUserId, undefined);
  assert.equal(manifest.configSchema.properties.ownerLabel, undefined);
});
test('large thread snapshots use bounded cursor pages and preserve every reply', async () => {
  const calls = [];
  const pages = [
    {messages: [{ts: '1.000001'}, {ts: '2.000001'}], has_more: true, response_metadata: {next_cursor: 'next'}},
    {messages: [{ts: '3.000001'}, {ts: '5.000001'}], has_more: false, response_metadata: {next_cursor: ''}},
  ];
  const messages = await loadSlackThreadSnapshot({channel: 'C123', threadId: '1.000001', latest: '4.000001', token: 'token', call: async (method, token, body) => {
    calls.push({method, token, body}); return pages[calls.length - 1];
  }});
  assert.deepEqual(messages.map(message => message.ts), ['1.000001', '2.000001', '3.000001']);
  assert.equal(calls[0].body.limit, 20);
  assert.equal(calls[0].body.cursor, undefined);
  assert.equal(calls[1].body.cursor, 'next');
});
test('thread snapshot fails closed when Slack claims more data without a cursor', async () => {
  await assert.rejects(loadSlackThreadSnapshot({channel: 'C123', threadId: '1.000001', latest: '4.000001', token: 'token',
    call: async () => ({messages: [], has_more: true, response_metadata: {}})}), /continuation cursor/);
});
test('only configured bot messages are claimed while a thread is closing or closed', () => {
  const botUserIds = new Set(['ULIV', 'UMAX']);
  assert.equal(shouldClaimClosedBotInbound({closingOrClosed: true, senderId: 'ULIV', botUserIds}), true);
  assert.equal(shouldClaimClosedBotInbound({closingOrClosed: true, senderId: 'UOWNER', botUserIds}), false);
  assert.equal(shouldClaimClosedBotInbound({closingOrClosed: false, senderId: 'ULIV', botUserIds}), false);
});
const toolContext = {messageChannel: 'slack', sessionKey: params.sessionKey, agentAccountId: 'max'};
const toolOptions = runtime => ({config: {channels: {slack: {accounts: {max: {}}}}}, lifecycle: runtime});
test('owner mixed instruction: the run finishes its work, then the host closes after the run ends', async t => {
  const f = fixture();
  await f.runtime.start(params);
  // "merge this, deploy, then close out this thread": other work happens in the run, then the agent requests close.
  const result = await closeThreadTool(toolContext, toolOptions(f.runtime)).execute();
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Only your final response after this call is delivered/);
  assert.equal(f.completed.size, 0, 'close never takes effect mid-run');
  await f.runtime.end(params);
  assert.deepEqual(f.order, ['working', 'act', 'snapshot', 'file', 'send', 'completion', 'closed']);
  assert.equal(await f.runtime.isClosingOrClosed(route), true);
});
test('close after a restart: no in-memory run or inbound message still closes the session thread', async () => {
  const f = fixture(); // a fresh lifecycle is what the host holds after a gateway restart mid-turn
  const result = await closeThreadTool(toolContext, toolOptions(f.runtime)).execute();
  assert.equal(result.isError, undefined);
  assert.deepEqual(f.order, ['snapshot', 'file', 'send', 'completion', 'closed']);
  assert.deepEqual(f.root, [{name: 'white_check_mark', users: ['UMAX']}]);
});
test('closure uses the canonical Slack route when the harness session key differs', async () => {
  const f = fixture();
  const harnessContext = {...toolContext, sessionKey: 'agent:max:acp:claude-cli:session-1',
    nativeChannelId: 'C123', deliveryContext: {channel: 'slack', to: 'channel:C123', threadId: route.threadId}};
  assert.equal((await closeThreadTool(harnessContext, toolOptions(f.runtime)).execute()).isError, undefined);
  assert.equal(await f.runtime.isClosingOrClosed(route), true);
});
test('close needs a Slack thread and a configured sender', async () => {
  const f = fixture();
  assert.equal((await closeThreadTool({...toolContext, agentAccountId: 'other'}, toolOptions(f.runtime)).execute()).isError, true);
  assert.equal((await closeThreadTool({...toolContext, sessionKey: 'agent:max:slack:direct:u1'}, toolOptions(f.runtime)).execute()).isError, true);
  assert.equal(f.completed.size, 0);
});
test('no close without a request: an owner run that never calls close_thread ends in act', async t => {
  const f = fixture();
  await f.runtime.start(params); await f.runtime.end(params);
  assert.deepEqual(f.order, ['working', 'act']); assert.equal(f.completed.size, 0);
  assert.equal(closeThreadTool({...toolContext, messageChannel: 'webchat'}, toolOptions(f.runtime)), undefined);
});
for (const accountId of ['liv','max']) test(`${accountId}: duplicate callbacks freeze once and complete after identical file/report`, async t => {
  const f = fixture();
  await Promise.all(Array.from({length: 4}, () => f.runtime.closeCommand(route, accountId)));
  assert.equal(f.receipts.size, 1); assert.equal(f.completed.size, 1);
  assert.equal(f.files.size, 1);
  assert.deepEqual(f.order, ['snapshot','file','send','completion','closed']);
  assert.deepEqual(f.root, [{name: 'white_check_mark', users: ['UMAX']}]);
});
test('closed is soft: the next admitted run replaces ✅ through ordinary admission and can be closed again', async t => {
  const f = fixture();
  await f.runtime.closeCommand(route, input);
  assert.equal(f.order.at(-1), 'closed');
  await f.runtime.closeCommand(route, input);
  assert.equal(f.receipts.size, 1);
  await f.runtime.start({...params, runId: 'r2'});
  await f.runtime.start({...params, runId: 'r2'});
  await f.runtime.end({...params, runId: 'r2'});
  assert.deepEqual(f.order.slice(-2), ['working', 'act']);
  assert.equal(await f.runtime.isClosingOrClosed(route), false);
  await f.runtime.closeCommand(route, input);
  assert.equal(f.order.at(-1), 'closed');
  assert.equal(f.receipts.size, 2); assert.equal(f.completed.size, 2);
});
test('a send the hook suppressed is reported as settled, not retried', async () => {
  const sdk = {buildOutboundSessionContext: value => value, sendDurableMessageBatch: async () => ({status: 'suppressed', payloadOutcomes: [{reason: 'cancelled_by_message_sending_hook'}]})};
  await sendThreadMessage({}, {key: 'k', route, text: 'text'}, sdk);
  const failed = {buildOutboundSessionContext: value => value, sendDurableMessageBatch: async () => ({status: 'failed', error: new Error('down')})};
  await assert.rejects(sendThreadMessage({}, {key: 'k', route, text: 'text'}, failed), /down/);
});
test('a run that ends after a close cannot overwrite the closed tile', async t => {
  const f = fixture();
  await f.runtime.start(params);
  await f.runtime.closeCommand(route, input);
  await f.runtime.end(params);
  assert.equal(f.order.at(-1), 'closed');
});
test('missing usage is reported as unavailable, not zero', () => {
  const report = formatCloseReport({agent: 'max'});
  assert.match(report, /Tokens: max usage unavailable/);
  assert.equal(summarizeTrajectory([{type: 'model.completed', data: {usage: {input: 99}}}], {before: Date.now()}), undefined);
});
test('segmented report retries reuse stable per-part intents and preserve semantic content', async () => {
  const report = 'A long supported outcome.\n'.repeat(400), receipts = new Map(), sent = [];
  const parts = reportParts(report); assert.equal(parts.join(''), report); assert.ok(parts.length > 1);
  let fail = true;
  const sdk = {buildOutboundSessionContext: value => value, sendDurableMessageBatch: async value => {
    assert.equal(value.requireUnknownSendReconciliation, true);
    // Stock reuse of a completed intent settles as 'suppressed' without resending.
    if (receipts.has(value.deliveryIntentId)) return {status: 'suppressed', results: []};
    sent.push(value.payloads[0].text); receipts.set(value.deliveryIntentId, true);
    if (fail && receipts.size === 2) {fail = false; throw new Error('ambiguous receipt');}
    return {status: 'sent', results: [{messageId: String(receipts.size)}]};
  }};
  const turn = {key: 'close:0', closeOperation: 'close:0', accountId: 'max', route, text: report};
  await assert.rejects(sendThreadMessage({}, turn, sdk));
  await sendThreadMessage({}, turn, sdk);
  assert.equal(sent.join(''), report); assert.equal(receipts.size, parts.length);
});
test('completion event is operation-idempotent and matches the already written Markdown', async t => {
  const f = {root: await mkdtemp(join(tmpdir(), 'host-close-'))}, report = formatCloseReport({agent: 'max'}), operationId = 'close:0';
  t.after(() => rm(f.root, {recursive: true, force: true}));
  const view = await writeCloseReport({dataRoot: f.root, operationId, report});
  const event = {dataRoot: f.root, operationId, report, agent: 'max', channel: route.channel, thread: route.threadId, now: new Date('2026-09-30T12:00:00Z')};
  await recordSessionClose(event); await recordSessionClose(event);
  assert.equal(await readFile(view, 'utf8'), report + '\n');
  assert.equal((await readFile(join(f.root, 'evidence/sessions/events/2026-09-30.jsonl'), 'utf8')).trim().split('\n').length, 1);
});


test('root tiles project with no state directory at all', async t => {
  const missing = join(tmpdir(), `no-openclaw-state-${process.pid}`), prior = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = missing;
  t.after(() => { if (prior === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = prior; });
  const f = fixture();
  await f.runtime.start(params); await f.runtime.end(params);
  await f.runtime.closeCommand(route, input);
  assert.deepEqual(f.order, ['working', 'act', 'snapshot', 'file', 'send', 'completion', 'closed']);
  assert.equal(existsSync(missing), false);
});
test('replay start, end, close and repeat close against Slack', async () => {
  const f = fixture();
  await f.runtime.start(params);
  assert.deepEqual(f.root, [{name: 'arrows_counterclockwise', users: ['UMAX']}]);
  await f.runtime.end(params);
  assert.deepEqual(f.root, [{name: 'raised_hand', users: ['UMAX']}]);
  await f.runtime.closeCommand(route, input);
  assert.deepEqual(f.root, [{name: 'white_check_mark', users: ['UMAX']}]);
  await f.runtime.closeCommand(route, input);
  assert.equal(f.receipts.size, 1, 'a repeated close while ✅ is on the root is a no-op');
  f.root.splice(0, 1, {name: 'white_check_mark', users: ['UOWNER']});
  assert.equal(await f.runtime.isClosingOrClosed(route), false, 'a human-held ✅ is not host closure');
});
