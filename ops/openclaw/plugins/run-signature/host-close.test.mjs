import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {FinalRuntime} from './final-runtime.mjs';
import {isCloseCommand, formatCloseReport, reportParts, summarizeTrajectory, writeCloseReport, recordSessionClose} from './session-close.mjs';
import {conversationFenceKey} from './conversation-fence.mjs';
import plugin, {sendFinalEnvelope} from './index.js';
const route = {channel: 'C123', threadId: '1790050400.000001'};
const input = {messageId: '1790050402.000001', principal: 'UOWNER', accountId: 'max'};
const params = {sessionKey: 'agent:max:slack:channel:c123:thread:1790050400.000001', runId: 'r1', agentId: 'max'};
const result = {assistantTexts: [JSON.stringify({schemaVersion: 1, message: 'Recorded result', status: 'act'})]};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'host-close-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const receipts = new Map(), completed = new Set(), files = new Map(), order = [];
  const options = {root, fences: {shouldSuppress: () => false},
    record: async () => {}, fault: async () => {}, wakes: async () => [],
    snapshot: async close => {order.push('snapshot'); return {report: formatCloseReport({agent: close.accountId}), evidence: close.evidence};},
    writeReport: async close => {order.push('file'); files.set(close.key, close.snapshot.report);},
    send: async close => {order.push('send'); if (!receipts.has(close.key)) receipts.set(close.key, {messageId: 'receipt:' + close.key}); return receipts.get(close.key);},
    completeClose: async close => {order.push('completion'); completed.add(close.key);},
    project: async status => {order.push(status);}};
  return {options, root, receipts, completed, files, order, runtime: new FinalRuntime(options)};
}
test('exact command grammar never strips untrusted text into a command', () => {
  for (const text of ['close this', ' Close this. ', 'CLOSE THIS!', '<@ULIV> close this', '<@ULIV> <@UMAX> Close this!']) assert.equal(isCloseCommand(text, ['ULIV','UMAX']), true, text);
  for (const text of ['please close this', 'close this?', 'close this and start another', "don't close this", '"close this"', '> close this', '`close this`', '```close this```', '<@UOTHER> close this', '<@ULIV>close this', 'close this!!', 'close this\nnow']) assert.equal(isCloseCommand(text, ['ULIV','UMAX']), false, text);
});
test('principal config and raw bot/forwarded text gates; non-owner callback performs no reservation', async () => {
  const register = pluginConfig => {
    plugin.register({config: {}, pluginConfig, on() {}});
    const runtime = globalThis[Symbol.for('humanware.final-envelope.v1')];
    runtime.sender = async () => undefined;
    return runtime;
  };
  const message = {channel: 'C123', ts: input.messageId, thread_ts: route.threadId, text: 'close this', user: 'UOWNER'};
  const config = {ownerUserId: 'UOWNER', threadOwnership: {accounts: {max: 'UMAX', liv: 'ULIV'}, defaultAccounts: {C123: 'max'}}};
  let runtime = register(config), reservations = 0;
  runtime.closeCommand = async () => {reservations++;};
  for (const patch of [{user: 'UOTHER'}, {bot_id: 'BBOT'}, {subtype: 'message_changed'}, {is_forwarded: true}, {text: '> close this'}, {text: '', attachments: [{text: 'close this'}]}]) assert.equal(await runtime.slackClose({message: {...message, ...patch}, accountId: 'max'}), false);
  assert.equal(await runtime.slackClose({message, accountId: 'liv'}), true);
  assert.equal(reservations, 0);
  assert.equal(await runtime.slackClose({message, accountId: 'max'}), true);
  assert.equal(reservations, 1);
  runtime = register({...config, ownerUserId: undefined});
  await assert.rejects(runtime.slackClose({message, accountId: 'max'}), /ownerUserId/);
  runtime = register({...config, threadOwnership: {accounts: config.threadOwnership.accounts}});
  await assert.rejects(runtime.slackClose({message, accountId: 'max'}), /sender/);
});
for (const accountId of ['liv','max']) test(`${accountId}: duplicate callbacks freeze once and complete after identical file/report`, async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({length: 4}, () => f.runtime.closeCommand(route, {...input, accountId})));
  assert.equal(f.receipts.size, 1); assert.equal(f.completed.size, 1);
  assert.equal(f.files.size, 1);
  assert.deepEqual(f.order, ['snapshot','file','send','completion','closed']);
  const state = JSON.parse(await readFile(join(f.root, 'final-decisions.json')));
  assert.equal(state.conversations[conversationFenceKey(route)].state, 'closed');
  assert.equal(Object.values(state.closes)[0].accountId, accountId);
  assert.equal(Object.values(state.closes)[0].principal, input.principal);
});
for (const boundary of ['snapshot', 'writeReport', 'send', 'completeClose', 'project']) test(`restart at ${boundary} recovers without a model turn or false closure`, async t => {
  const f = await fixture(t);
  const original = f.runtime[boundary];
  f.runtime[boundary] = async (...args) => {if (boundary === 'send' || boundary === 'completeClose') await original(...args); throw new Error('crash');};
  await assert.rejects(f.runtime.closeCommand(route, input), /crash/);
  const state = JSON.parse(await readFile(join(f.root, 'final-decisions.json')));
  assert.equal(state.conversations[conversationFenceKey(route)].state, 'closing');
  await new FinalRuntime(f.options).recover();
  assert.equal(f.receipts.size, 1); assert.equal(f.completed.size, 1);
  assert.equal(f.order.at(-1), 'closed');
  await new FinalRuntime(f.options).recover();
  assert.equal(f.receipts.size, 1);
});
test('reservation alone recovers; fenced results stay recorded after reopen', async t => {
  const f = await fixture(t);
  let release, entered;
  const running = new Promise(resolve => {entered = resolve;});
  const gate = new Promise(resolve => {release = resolve;});
  const task = f.runtime.run(params, async () => {entered(); await gate; return result;}, 'codex');
  await running;
  await f.runtime.reserveClose(route, input);
  await assert.rejects(f.runtime.run({...params, runId: 'r2'}, async () => result, 'codex'), /fenced/);
  await f.runtime.recover();
  await f.runtime.human(route, {messageId: '1790050403.000001', text: 'new work'});
  release(); await task;
  const state = await f.runtime.state(state => state);
  assert.equal(state.conversations[conversationFenceKey(route)].generation, 1);
  assert.equal(state.turns[conversationFenceKey(route) + ':r1'].phase, 'intentional_non_delivery');
  assert.equal(state.turns[conversationFenceKey(route) + ':r1'].envelope.message, 'Recorded result');
  assert.equal(f.receipts.size, 1);
  await f.runtime.run({...params, runId: 'r3'}, async () => result, 'codex');
  assert.equal(f.receipts.size, 2);
  await f.runtime.human(route, {messageId: input.messageId, text: 'close this'});
  assert.equal((await f.runtime.state(state => state.conversations[conversationFenceKey(route)])).generation, 1);
});
test('an already-started send settles before reservation; later final cannot overwrite closed tile', async t => {
  const f = await fixture(t); let release, entered;
  const started = new Promise(resolve => {entered = resolve;});
  const gate = new Promise(resolve => {release = resolve;});
  f.runtime.send = async turn => {if (!turn.closeOperation) {entered(); await gate;} return f.options.send(turn);};
  const task = f.runtime.run(params, async () => result, 'codex');
  await started;
  const close = f.runtime.closeCommand(route, input);
  release(); await Promise.all([task, close]);
  assert.equal(f.order.at(-1), 'closed');
  assert.equal(f.receipts.size, 2);
});
for (const legacy of [{state: 'closing'}, {state: 'closed'}, {state: 'open'}]) test(`ambiguous/conflicting legacy ${legacy.state} stops rather than reopening`, async t => {
  const f = await fixture(t), key = conversationFenceKey(route);
  await writeFile(join(f.root, 'conversation-fences.json'), JSON.stringify({schemaVersion: 1, conversations: {[key]: legacy}}));
  await f.runtime.state(state => {state.conversations[key] = {status: 'closed'};});
  await assert.rejects(f.runtime.closeCommand(route, input), /reconciliation/);
  await assert.rejects(f.runtime.human(route, {messageId: '1790050403.000001'}), /reconciliation/);
  assert.equal(f.receipts.size, 0);
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
  const turn = {key: 'close:0', closeOperation: 'close:0', accountId: 'max', route, envelope: {message: report}};
  await assert.rejects(sendFinalEnvelope({}, turn, sdk));
  await sendFinalEnvelope({}, turn, sdk);
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

test('root command gives only a thread instruction, never a closure reservation', async () => {
  plugin.register({config: {}, pluginConfig: {ownerUserId: 'UOWNER', threadOwnership: {accounts: {max: 'UMAX'}, defaultAccounts: {C123: 'max'}}}, on() {}});
  const runtime = globalThis[Symbol.for('humanware.final-envelope.v1')], sends = [];
  runtime.send = async turn => {sends.push(turn); return {messageId: 'receipt'};};
  runtime.closeCommand = async () => assert.fail('root must not reserve a closure');
  assert.equal(await runtime.slackClose({accountId: 'max', message: {channel: 'C123', ts: input.messageId, user: 'UOWNER', text: 'close this'}}), true);
  assert.match(sends[0].envelope.message, /inside the thread/);
  assert.equal(sends[0].route.threadId, input.messageId);
});
test('expired uncertain close receipt stops for reconciliation', async t => {
  const f = await fixture(t);
  f.runtime.send = async () => {throw new Error('unknown');};
  await assert.rejects(f.runtime.closeCommand(route, input));
  await f.runtime.state(state => {Object.values(state.closes)[0].sendStartedAt = Date.now() - 86400001;});
  await new FinalRuntime(f.options).recover();
  assert.equal(f.receipts.size, 0);
  assert.equal((await f.runtime.state(state => state.conversations[conversationFenceKey(route)])).state, 'closing');
});
test('orphan turn cannot silently create an open boundary and publish', async t => {
  const f = await fixture(t), conversation = conversationFenceKey(route), key = conversation + ':orphan';
  await f.runtime.state(state => {state.turns[key] = {key, conversation, route, phase: 'reserved', envelope: {status: 'act', message: 'old'}, startedAt: Date.now()};});
  await f.runtime.recover();
  assert.equal(f.receipts.size, 0);
  await assert.rejects(f.runtime.reserveClose(route, input), /Orphan/);
});
test('an imported historical boundary retains closedThrough after human reopening', async t => {
  const f = await fixture(t), key = conversationFenceKey(route);
  await writeFile(join(f.root, 'conversation-fences.json'), JSON.stringify({schemaVersion: 1, conversations: {[key]: {state: 'closed', closedThrough: 1000, closeMessageId: 'legacy-receipt'}}}));
  await f.runtime.state(state => {state.conversations[key] = {status: 'closed'};});
  await f.runtime.human(route, {messageId: input.messageId});
  const conversation = await f.runtime.state(state => state.conversations[key]);
  assert.equal(conversation.generation, 1);
  assert.equal(conversation.closedThrough, 1000);
  assert.equal(conversation.legacyBoundary.closeMessageId, 'legacy-receipt');
  assert.equal(f.runtime.eligible({generation: 0, startedAt: 500}, conversation), false);
});

test('only checked host sends cross message hook fences, including valid reopened finals', async () => {
  const hooks = new Map();
  plugin.register({config: {}, on(name, callback) {hooks.set(name, callback);}});
  const runtime = globalThis[Symbol.for('humanware.final-envelope.v1')];
  runtime.fences.shouldSuppress = () => true;
  const event = {to: 'C123', threadId: route.threadId}, context = {channelId: 'slack', sessionKey: params.sessionKey};
  const hook = hooks.get('message_sending');
  assert.equal(hook(event, context).cancel, true);
  const sdk = {buildOutboundSessionContext: value => value, sendDurableMessageBatch: async () => {
    assert.equal(hook(event, context), undefined);
    return {status: 'sent', results: [{messageId: 'receipt'}]};
  }};
  for (const closeOperation of [undefined, 'close:0']) await sendFinalEnvelope({}, {key: 'checked', closeOperation, route, envelope: {message: 'Valid host output'}}, sdk);
  assert.equal(hook(event, context).cancel, true);
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
  const restarted = new FinalRuntime(f.options);
  // The durable ingress retries the same raw source event if reservation itself
  // never committed. Once reserved, startup recovery needs no inbound/model turn.
  if (phase === 'reserved') await restarted.closeCommand(route, input);
  else await restarted.recover();
  assert.equal(f.receipts.size, 1); assert.equal(f.completed.size, 1);
  assert.equal((await restarted.state(state => state.conversations[conversationFenceKey(route)])).state, 'closed');
});

test('existing journal owner binds sender even when the routing projection is absent', async t => {
  const f = await fixture(t), key = conversationFenceKey(route);
  await f.runtime.state(state => {
    state.turns[key + ':old'] = {key: key + ':old', conversation: key, accountId: 'liv', phase: 'sent'};
    state.conversations[key] = {status: 'act', owner: key + ':old'};
  });
  assert.equal(await f.runtime.sender(route), 'liv');
  await f.runtime.run(params, async () => result, 'codex');
  await f.runtime.human(route, {messageId: input.messageId, text: 'a new request'});
  assert.equal(await f.runtime.sender(route), 'max');
});

test('an old delivered model-closed decision is retained for reconciliation, not completed by recovery', async t => {
  const f = await fixture(t), conversation = conversationFenceKey(route), key = conversation + ':legacy-close';
  await f.runtime.state(state => {
    state.conversations[conversation] = {owner: key, status: 'act'};
    state.turns[key] = {key, route, conversation, phase: 'delivered', messageId: 'old-ack', envelope: {schemaVersion: 1, message: 'Closed.', status: 'closed'}};
  });
  await f.runtime.recover();
  assert.equal((await f.runtime.state(state => state.turns[key])).phase, 'delivered');
  assert.equal(f.completed.size, 0); assert.equal(f.receipts.size, 0);
  assert.equal(f.order.includes('closed'), false);
  await assert.rejects(f.runtime.human(route, {messageId: input.messageId}), /reconciliation/);
});
