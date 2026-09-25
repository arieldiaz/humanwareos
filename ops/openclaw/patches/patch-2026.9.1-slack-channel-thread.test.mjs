import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { slackThreadBodyEntry } from "../slack-channel-thread.mjs";

const patch = fileURLToPath(new URL("./patch-2026.9.1-slack-channel-thread.mjs", import.meta.url));
const source = fs.readFileSync(patch, "utf8");
// Collect the reviewed edits without performing filesystem I/O. The synthetic
// fixture exercises shape checking; real bundle execution is a separate rehearsal.
const edits = [];
const declarations = source.slice(source.indexOf('const delivery ='), source.indexOf('// Validate every anchor'));
vm.runInNewContext(declarations, { edit: (file, before, after) => edits.push({ file, before, after }) });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "slack-thread-patch-"));
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.9.1", type: "module" }));
  for (const file of new Set(edits.map((edit) => edit.file))) fs.writeFileSync(path.join(root, "dist", file), edits.filter((edit) => edit.file === file).map((edit) => edit.before).join("\n"));
  return root;
}
function apply(root) {
  return execFileSync(process.execPath, [patch], { env: { ...process.env, OPENCLAW_PACKAGE_ROOT: root, OPENCLAW_CORE_DIST: path.join(root, "dist") }, encoding: "utf8", stdio: "pipe" });
}

test("patch checks every shape, is idempotent, and copies its one shared owner", () => {
  const root = fixture();
  try {
    apply(root);
    const snapshot = fs.readdirSync(path.join(root, "dist")).map((file) => fs.readFileSync(path.join(root, "dist", file), "utf8"));
    apply(root);
    assert.deepEqual(fs.readdirSync(path.join(root, "dist")).map((file) => fs.readFileSync(path.join(root, "dist", file), "utf8")), snapshot);
    assert.equal(fs.readFileSync(path.join(root, "dist/humanware-slack-channel-thread.mjs"), "utf8"), fs.readFileSync(new URL("../slack-channel-thread.mjs", import.meta.url), "utf8"));
    // An already-patched marker is not enough to skip validation.
    const target = path.join(root, "dist/send-BcPUy9RI.js");
    fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace('title: request.title', 'title: changedShape'));
    assert.throws(() => apply(root), /anchor changed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("unsupported version or missing anchor fails before any bundle mutation", () => {
  for (const version of ["2026.9.2", "2026.9.1"]) {
    const root = fixture();
    try {
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));
      if (version === "2026.9.1") fs.writeFileSync(path.join(root, "dist/send-BcPUy9RI.js"), "unreviewed");
      const before = fs.readFileSync(path.join(root, "dist/deliver-B6F55ipQ.js"), "utf8");
      assert.throws(() => apply(root));
      assert.equal(fs.readFileSync(path.join(root, "dist/deliver-B6F55ipQ.js"), "utf8"), before);
      assert.equal(fs.existsSync(path.join(root, "dist/humanware-slack-channel-thread.mjs")), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

// This is deliberately opt-in: never writes to the installed runtime. Run against
// an independently copied, patched 2026.9.1 distribution for release verification.
const rehearsal = process.env.HUMANWARE_SLACK_THREAD_REHEARSAL;
function readBundle(name) { return fs.readFileSync(path.join(rehearsal, "dist", name), "utf8"); }
function extract(text, name) {
  const start = text.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return text.slice(text.slice(Math.max(0, start - 6), start) === "async " ? start - 6 : start, text.indexOf("\n}", start) + 2);
}
function queueHarness(options = {}) {
  let entry = { id: "queue", channel: "slack", to: "C123", slackChannelThread: { title: "Weekly review" }, requiresProducerClaim: true, producerClaimId: "owner", recoveryState: "producer_claimed", availableAt: Date.now() + 300000 };
  let acked = false;
  const events = [];
  const bodyParams = [];
  class OutboundDeliveryError extends Error { constructor(message, details) { super(message); Object.assign(this, details); } }
  const globals = {
    createSubsystemLogger: () => ({ warn() {} }),
    createMessageSentEmitter: () => ({ emitMessageSent() {}, hasMessageSentHooks: false }),
    OUTBOUND_DELIVERY_LOG_SCOPE: "test",
    getGlobalHookRunner: () => null,
    emitOutboundAuditLifecycle() {}, emitOutboundAuditTerminals() {},
    completedOutboundAuditTerminals() {}, failedOutboundAuditTerminals() {},
    assertSessionWriterDeliveryAuthorized() { if (options.revoked) throw Object.assign(new Error("revoked"), { provenNotSent: true }); },
    settleDurableDelivery() { events.push("complete"); },
    runOutboundDeliveryCommitHooks() {},
    createQueuedDeliveryOwner: () => ({ ack: async () => { acked = true; events.push("ack"); }, fail: async (fn, error) => fn("queue", error) }),
    persistQueuedPreSendState: async () => { entry.recoveryState = "send_attempt_started"; return "marked"; },
    markDeliveryPlatformSendDispatched: async () => { entry.recoveryState = "send_attempt_started"; events.push("dispatch"); },
    persistQueuedPostSendState: async () => { entry.recoveryState = "unknown_after_send"; return "marked"; },
    failDelivery: async () => { events.push("failed"); if (entry.recoveryState === "producer_claimed") entry.recoveryState = undefined; },
    failDeliveryBeforePlatformSend: async () => { entry.recoveryState = undefined; events.push("failed-before-send"); },
    failDeliveryAfterPlatformSend: async () => { entry.recoveryState = "unknown_after_send"; events.push("failed-after-send"); },
    isOutboundDeliveryAdmissionClosedError: () => false,
    isDeliveryAbortError: (err) => err.name === "AbortError",
    isProvenDeliveryNotSentError: (err) => err?.provenNotSent === true,
    findPlatformMessageRejectedError: () => undefined,
    OutboundDeliveryError,
    formatErrorMessage: (err) => err.message,
    areOutboundPayloadsIntentionallySuppressed: () => false,
    checkpointSlackThreadRoot: (id, messageId, stateDir, claim) => {
      if (options.crashAtCheckpoint) throw new Error("crash before root checkpoint");
      entry = slackThreadBodyEntry(entry, messageId, claim); events.push("root-checkpoint");
    },
    recordFinalEnvelopeReceipt() {},
    recordSlackThreadBodyResult: (id, result) => { entry.slackChannelThread.result = result; },
    createChannelHandler: async (params) => ({ sendText: async (text) => {
      assert.equal(params.deliveryQueueId, "queue:slack-root");
      assert.equal(text, "Weekly review");
      await params.onPlatformSendStart({});
      await params.onPlatformSendDispatch();
      events.push("root");
      if (options.unknownRoot) throw new Error("connection lost after root");
      return { messageId: "1.0" };
    } }),
    deliverOutboundPayloadsCore: async (params) => {
      bodyParams.push(params);
      assert.equal(params.threadId, "1.0");
      if (options.bodyNoIdentity) return [];
      if (options.bodyAbort) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      if (options.bodyFailsBeforeSend) throw Object.assign(new Error("body unavailable"), { provenNotSent: true });
      await params.onPlatformSendStart({ replyToId: params.threadId }, 0);
      await params.onPlatformSendDispatch();
      const result = { channel: "slack", messageId: "2.0", threadTs: params.threadId };
      if (options.bodyUnknown) throw new Error("body timeout");
      await params.onDeliveryResult(result);
      if (options.partialBody) throw new OutboundDeliveryError("second attachment failed", { results: [result], payloadOutcomes: [], sentBeforeError: true });
      events.push("body");
      params.onPayloadDeliveryOutcome({ index: 0, status: "sent", results: [result] });
      return [result];
    },
  };
  const context = vm.createContext(globals);
  vm.runInContext(extract(readBundle("deliver-B6F55ipQ.js"), "deliverOutboundPayloadsWithQueueCleanup"), context);
  const payloads = [{ text: "Full report", mediaUrls: ["/spool/report.pdf"] }];
  const run = () => context.deliverOutboundPayloadsWithQueueCleanup({ channel: "slack", to: "C123", payloads, slackChannelThread: entry.slackChannelThread, threadId: entry.threadId, requireUnknownSendReconciliation: true, queuePolicy: "required", reusePendingDeliveryIntent: true }, "queue", Date.now(), "owner");
  return { run, events, bodyParams, payloads, entry: () => entry, acked: () => acked };
}

test("copied bundle: root/body publication retains body payloads and completes only after body", { skip: !rehearsal }, async () => {
  const h = queueHarness();
  const results = await h.run();
  assert.equal(results[0].messageId, "2.0");
  assert.equal(h.bodyParams[0].payloads, h.payloads);
  assert.equal(h.entry().slackChannelThread.rootMessageId, "1.0");
  assert.equal(h.acked(), true);
  assert.ok(h.events.indexOf("root-checkpoint") < h.events.indexOf("body"));
  assert.ok(h.events.indexOf("body") < h.events.indexOf("ack"));
});

test("copied bundle: root-only success retries body without reposting root", { skip: !rehearsal }, async () => {
  const options = { bodyFailsBeforeSend: true };
  const h = queueHarness(options);
  await assert.rejects(h.run(), /body unavailable/);
  assert.equal(h.acked(), false);
  assert.equal(h.entry().threadId, "1.0");
  options.bodyFailsBeforeSend = false;
  await h.run();
  assert.equal(h.events.filter((event) => event === "root").length, 1);
  assert.equal(h.events.filter((event) => event === "body").length, 1);
  assert.equal(h.acked(), true);
});

for (const failure of ["unknownRoot", "crashAtCheckpoint", "bodyUnknown", "bodyNoIdentity", "bodyAbort", "partialBody", "revoked"]) test(`copied bundle: ${failure} cannot acknowledge body`, { skip: !rehearsal }, async () => {
  const h = queueHarness({ [failure]: true });
  await assert.rejects(h.run());
  assert.equal(h.acked(), false);
  assert.equal(h.events.includes("complete"), false);
  if (failure === "revoked") assert.equal(h.events.includes("root"), false);
});

test("copied recovery: reconciled root resumes body; it does not complete the intent", { skip: !rehearsal }, async () => {
  for (const lostRace of [false, true]) {
    const entry = { id: "queue", slackChannelThread: { title: "Title" }, recoveryState: "unknown_after_send", deliveryCompletion: { kind: "conversation" } };
    let replayed;
    const context = vm.createContext({
      resolveMaxRetries: () => 10, resolveAttemptCount: () => 1,
      resolveCompletedOwnerBeforeRecovery: async () => "continue",
      needsUnknownSendReconciliation: () => true,
      reconcileUnknownQueuedDelivery: async () => ({ status: "sent", messageId: "1.0" }),
      queuedDeliveryPayloads: () => [{ text: "Full body", mediaUrls: ["attachment.pdf"] }],
      recoverSlackThreadRoot: (current, id) => lostRace ? null : slackThreadBodyEntry(current, id),
      completeDurableDelivery() { assert.fail("root completed the intent"); },
      ackRecoveredDelivery() { assert.fail("root acknowledged the queue"); },
    });
    vm.runInContext(extract(readBundle("delivery-queue-recovery-CAUTn65F.js"), "drainQueuedEntry"), context);
    const drain = context.drainQueuedEntry;
    context.drainQueuedEntry = async (opts) => { replayed = opts.entry; return "body-resumed"; };
    assert.equal(await drain({ entry, log: { warn() {} } }), lostRace ? "already-gone" : "body-resumed");
    if (!lostRace) {
      assert.equal(replayed.threadId, "1.0");
      assert.equal(replayed.recoveryState, undefined);
      assert.equal(replayed.deliveryCompletion, entry.deliveryCompletion);
    } else assert.equal(replayed, undefined);
  }
});

test("copied storage: real SQLite custody, restart checkpoint, completion replay and owner fencing", { skip: !rehearsal }, async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-thread-db-"));
  try {
    const storage = await import(new URL(`file://${path.join(rehearsal, "dist/delivery-queue-storage-BmsyhVaX.js")}`));
    const claim = storage.N();
    const id = "slack-send:test";
    await storage.r({ channel: "slack", to: "C123", payloads: [{ text: "body" }], slackChannelThread: { title: "Title" }, initialProducerClaim: claim, completionRetention: { idPrefix: "slack-send:", maxAgeMs: 86400000, maxEntries: 2000 } }, id, stateDir);
    await storage.b(id, stateDir, {}, claim.producerClaimId);
    assert.throws(() => storage.checkpointSlackThreadRoot(id, "1.0", stateDir, "wrong-owner"), /claim was lost/);
    storage.checkpointSlackThreadRoot(id, "1.0", stateDir, claim.producerClaimId);
    const entry = await storage.p(id, stateDir);
    assert.equal(entry.threadId, "1.0");
    assert.equal(entry.preparedBatch.entries[0].payload.text, "body");
    assert.equal(entry.recoveryState, "producer_claimed");
    assert.equal(storage.u(id, stateDir).status, "pending");
    await storage.b(id, stateDir, { replyToId: "1.0" }, claim.producerClaimId);
    storage.recordSlackThreadBodyResult(id, { channel: "slack", messageId: "2.0", threadTs: "1.0" }, stateDir, claim.producerClaimId);
    await storage.t(id, stateDir, { expectedPlatformSendAttemptId: claim.producerClaimId });
    assert.equal(storage.u(id, stateDir).status, "completed");
    assert.deepEqual(storage.completedSlackThreadResults(id, stateDir), [{ channel: "slack", messageId: "2.0", threadTs: "1.0" }]);
    assert.equal((await storage.r({ channel: "slack", to: "C123", payloads: [{ text: "body" }] }, id, stateDir)).created, false);
    const recoveryId = "slack-send:recovery";
    const recoveryClaim = storage.N();
    await storage.r({ channel: "slack", to: "C123", payloads: [{ text: "body" }], slackChannelThread: { title: "Title" }, initialProducerClaim: recoveryClaim }, recoveryId, stateDir);
    await storage.b(recoveryId, stateDir, {}, recoveryClaim.producerClaimId);
    const rootOnly = await storage.p(recoveryId, stateDir);
    assert.ok(storage.recoverSlackThreadRoot(rootOnly, "3.0", stateDir));
    assert.equal(storage.recoverSlackThreadRoot(rootOnly, "4.0", stateDir), null);
    assert.equal((await storage.p(recoveryId, stateDir)).threadId, "3.0");
    assert.equal(storage.u(recoveryId, stateDir).status, "pending");
    assert.ok(await storage.D(recoveryId, stateDir));
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test("copied recovery cannot recreate a gateway caller's process-local authority", { skip: !rehearsal }, async () => {
  const context = vm.createContext({
    resolveMaxRetries: () => 10, resolveAttemptCount: () => 1,
    resolveCompletedOwnerBeforeRecovery: async () => "continue",
    needsUnknownSendReconciliation: () => false,
  });
  vm.runInContext(extract(readBundle("delivery-queue-recovery-CAUTn65F.js"), "drainQueuedEntry"), context);
  const result = await context.drainQueuedEntry({
    entry: { id: "queue", slackChannelThread: { rootMessageId: "1.0", liveAuthorityOnly: true } },
    log: { info() {} },
    deliver() { assert.fail("recovery dispatched without live authority"); },
  });
  assert.equal(result, "failed");
});

test('copied storage: final replies retain their receipt and cannot re-enqueue after completion', {skip: !rehearsal}, async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'final-envelope-db-'));
  try {
    const storage = await import(new URL(`file://${path.join(rehearsal, 'dist/delivery-queue-storage-BmsyhVaX.js')}`));
    const claim = storage.N(), id = 'humanware-final:conversation:run';
    await storage.r({channel: 'slack', to: 'C123', threadId: 'root', payloads: [{text: 'Unchanged.'}], initialProducerClaim: claim,
      completionRetention: {idPrefix: 'humanware-final:', maxAgeMs: 86400000, maxEntries: 2000}}, id, stateDir);
    await storage.b(id, stateDir, {replyToId: 'root'}, claim.producerClaimId);
    assert.throws(() => storage.recordFinalEnvelopeReceipt(id, {channel: 'slack', messageId: 'reply'}, stateDir, 'wrong'), /claim was lost/);
    storage.recordFinalEnvelopeReceipt(id, {channel: 'slack', messageId: 'reply'}, stateDir, claim.producerClaimId);
    assert.deepEqual(storage.completedFinalEnvelopeResults(id, stateDir), []);
    await storage.t(id, stateDir, {expectedPlatformSendAttemptId: claim.producerClaimId});
    assert.deepEqual(storage.completedFinalEnvelopeResults(id, stateDir), [{channel: 'slack', messageId: 'reply'}]);
    assert.equal((await storage.r({channel: 'slack', to: 'C123', payloads: [{text: 'Unchanged.'}]}, id, stateDir)).created, false);
  } finally { fs.rmSync(stateDir, {recursive: true, force: true}); }
});
