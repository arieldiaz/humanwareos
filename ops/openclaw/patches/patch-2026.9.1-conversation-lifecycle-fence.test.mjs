import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const patchPath = fileURLToPath(new URL("./patch-2026.9.1-conversation-lifecycle-fence.mjs", import.meta.url));

const fixtures = {
  "subagent-completion-delivery-fixture.js": `import { S as getTaskById, x as findTaskByRunId } from "./task.js";
function resolveCorrelatedSubagentDelivery(queued) {
\tif (queued.kind !== "agentTurn" || queued.owner?.kind !== "subagent_completion") return queued;
}
async function settleCorrelatedSubagentDelivery(queued, outcome) {
\tconst delivery = ensureDeliveryState(subagent);
\tif (outcome === "recovered") {
\t\tObject.assign(delivery, {
\t\t\tstatus: "delivered"
\t\t});
\t}
}
export { settleCorrelatedSubagentDelivery as a, retrySubagentCompletionDelivery as i, dismissSubagentCompletionDelivery as n, resolveCorrelatedSubagentDelivery as r, admitCorrelatedSubagentSessionDelivery as t };`,
  "server-restart-sentinel-fixture.js": `import { a as settleCorrelatedSubagentDelivery, r as resolveCorrelatedSubagentDelivery } from "./subagent-completion-delivery-fixture.js";
async function deliverQueuedSessionDelivery(params) {
\tconst queuedEntry = resolveCorrelatedSubagentDelivery(params.entry);
}`,
  "subagent-announce-delivery-fixture.js": `import { m as clampTimerTimeoutMs } from "./number.js";
function sourceOwnerChangedResult() {
\treturn {
\t\tdelivered: false
\t};
}
async function deliverSubagentAnnouncement(params) {
\tconst sourceOwnerChanged = () => params.isSourceSessionEffectsAllowed?.() === false;
}`,
  "subagent-announce.requester-settle-wake-fixture.js": `import { r as truncateUtf16Safe } from "./utf16.js";
function settle(settledBatch, params, requesterSessionKey, batchRunIds, completeBatch, hasUnsettledDescendants) {
\tconst batchRunIds = settledBatch.map((entry) => entry.runId).toSorted();
\tconst selectedState = readSharedBatchState(settledBatch);
\tif (hasUnsettledDescendants) {
\t\treturn false;
\t}
}`,
  "subagent-completion-admission.store-fixture.js": `function blockSubagentCompletionDelivery(params) {
\treturn runOpenClawStateWriteTransaction((database) => {
\t\tconst subagent = readSubagentRun(database, params.subagent.runId);
\t\tconst task = readTaskRecord(database.db, params.taskId);
\t\tconst delivery = ensureDeliveryState(subagent);
\t\tdelivery.payload ??= loadPendingFinalDeliveryPayload(subagent);
\t\tObject.assign(delivery, {
\t\t\tstatus: "failed"
\t\t});
\t});
}`,
  "subagent-registry-AFIXTURE.js": `entry.suppressCompletionDelivery = killReconciliation.suppressTaskDelivery === true ? true : void 0;
skipRequesterSettleWake: skipRequesterDelivery,
isCompletionOwnedByRequesterYield: () => entry.requesterTurnYielded === true || entry.requesterSettleWake?.requesterYieldBatch === true,
requesterYieldBatch: true,`,
};

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-conversation-fence-patch-"));
  for (const [name, source] of Object.entries(fixtures)) fs.writeFileSync(path.join(root, name), source);
  return root;
}

function apply(root) {
  return execFileSync(process.execPath, [patchPath], {
    env: { ...process.env, OPENCLAW_CORE_DIST: root },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("fences completion and settle admission and records intentional non-delivery", () => {
  const root = makeFixture();
  apply(root);
  const completion = fs.readFileSync(path.join(root, "subagent-completion-delivery-fixture.js"), "utf8");
  const sentinel = fs.readFileSync(path.join(root, "server-restart-sentinel-fixture.js"), "utf8");
  const announce = fs.readFileSync(path.join(root, "subagent-announce-delivery-fixture.js"), "utf8");
  const settle = fs.readFileSync(path.join(root, "subagent-announce.requester-settle-wake-fixture.js"), "utf8");
  const admission = fs.readFileSync(path.join(root, "subagent-completion-admission.store-fixture.js"), "utf8");

  assert.match(completion, /shouldSuppressCorrelatedSubagentDelivery/);
  assert.match(completion, /outcome === "intentional_non_delivery"/);
  assert.match(sentinel, /settleCorrelatedSubagentDelivery\(params\.entry, "intentional_non_delivery"\)/);
  assert.match(announce, /params\.expectsCompletionMessage && shouldSuppressConversationDelivery/);
  assert.match(settle, /completeRequesterSettleWakeBatch/);
  assert.match(settle, /suppressedBatch = settledBatch\.filter/);
  assert.match(settle, /settledBatch = settledBatch\.filter\(\(entry\) => !suppressedBatch\.includes\(entry\)\)/);
  assert.match(settle, /reason: "conversation_closed"/);
  assert.match(admission, /status: "not_required"/);
  assert.match(admission, /deliveryStatus: "dismissed"/);
  assert.doesNotMatch(admission, /formatTaskBlockedFollowupMessage\(task\).*intentional_non_delivery/s);
  assert.equal(fs.existsSync(path.join(root, "humanware-conversation-fence.mjs")), true);
});

test("retired-child suppression and requester-settle single ownership are guarded", () => {
  const root = makeFixture();
  apply(root);
  const registry = fs.readFileSync(path.join(root, "subagent-registry-AFIXTURE.js"), "utf8");
  assert.match(registry, /suppressCompletionDelivery = killReconciliation\.suppressTaskDelivery/);
  assert.match(registry, /skipRequesterSettleWake: skipRequesterDelivery/);
  assert.match(registry, /isCompletionOwnedByRequesterYield/);
  assert.match(registry, /requesterYieldBatch: true/);
});

test("patch is idempotent", () => {
  const root = makeFixture();
  apply(root);
  const first = Object.fromEntries(fs.readdirSync(root).map((name) => [name, fs.readFileSync(path.join(root, name), "utf8")]));
  apply(root);
  const second = Object.fromEntries(fs.readdirSync(root).map((name) => [name, fs.readFileSync(path.join(root, name), "utf8")]));
  assert.deepEqual(second, first);
});

test("fails closed when a reviewed control-plane site changes", () => {
  const root = makeFixture();
  fs.writeFileSync(path.join(root, "server-restart-sentinel-fixture.js"), "changed upstream");
  assert.throws(() => apply(root));
});
