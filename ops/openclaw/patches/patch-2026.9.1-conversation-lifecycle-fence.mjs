import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = process.env.OPENCLAW_PACKAGE_ROOT || "/opt/homebrew/lib/node_modules/openclaw";
const distDir = process.env.OPENCLAW_CORE_DIST || path.join(packageRoot, "dist");

function bundle(pattern, label) {
  const matches = fs.readdirSync(distDir).filter((name) => pattern.test(name));
  if (matches.length !== 1) throw new Error(`Expected one ${label} bundle in reviewed OpenClaw 2026.9.1, found ${matches.length}.`);
  return path.join(distDir, matches[0]);
}

function bundleContaining(pattern, marker, label) {
  const matches = fs.readdirSync(distDir)
    .filter((name) => pattern.test(name))
    .map((name) => path.join(distDir, name))
    .filter((file) => fs.readFileSync(file, "utf8").includes(marker));
  if (matches.length !== 1) throw new Error(`Expected one ${label} bundle with its reviewed marker, found ${matches.length}.`);
  return matches[0];
}

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) throw new Error(`Expected one ${label} site in reviewed OpenClaw 2026.9.1.`);
  return source.replace(before, after);
}

function patchFile(file, transforms) {
  const original = fs.readFileSync(file, "utf8");
  const source = transforms.reduce((value, transform) => transform(value), original);
  if (source !== original) fs.writeFileSync(file, source);
  return source === original ? "alreadyPatched" : "patched";
}

const helperSource = fileURLToPath(new URL("../plugins/run-signature/conversation-fence.mjs", import.meta.url));
const helperTarget = path.join(distDir, "humanware-conversation-fence.mjs");
const helper = fs.readFileSync(helperSource, "utf8");
if (!fs.existsSync(helperTarget) || fs.readFileSync(helperTarget, "utf8") !== helper) fs.writeFileSync(helperTarget, helper);

const completionFile = bundle(/^subagent-completion-delivery-.*\.js$/, "subagent completion delivery");
const completionResult = patchFile(completionFile, [
  (source) => replaceOnce(source,
    `import { S as getTaskById, x as findTaskByRunId } from`,
    `import { shouldSuppressConversationDelivery } from "./humanware-conversation-fence.mjs";\nimport { S as getTaskById, x as findTaskByRunId } from`,
    "completion fence import"),
  (source) => replaceOnce(source,
    `function resolveCorrelatedSubagentDelivery(queued) {\n\tif (queued.kind !== "agentTurn" || queued.owner?.kind !== "subagent_completion") return queued;`,
    `function shouldSuppressCorrelatedSubagentDelivery(queued) {\n\tif (queued.kind !== "agentTurn" || queued.owner?.kind !== "subagent_completion") return false;\n\tconst entry = subagentRuns.get(queued.owner.runId);\n\treturn Boolean(entry && shouldSuppressConversationDelivery({\n\t\tsessionKey: entry.requesterSessionKey,\n\t\torigin: entry.requesterOrigin\n\t}, { workCreatedAt: entry.createdAt }));\n}\nfunction resolveCorrelatedSubagentDelivery(queued) {\n\tif (queued.kind !== "agentTurn" || queued.owner?.kind !== "subagent_completion") return queued;`,
    "correlated completion fence"),
  (source) => replaceOnce(source,
    `\tif (outcome === "recovered") {\n\t\tObject.assign(delivery, {`,
    `\tif (outcome === "intentional_non_delivery") {\n\t\tObject.assign(delivery, {\n\t\t\tstatus: "not_required",\n\t\t\tdisposition: "intentional_non_delivery",\n\t\t\tlastError: "target conversation is durably closed",\n\t\t\tnextAttemptAt: void 0,\n\t\t\tqueueId: void 0\n\t\t});\n\t\tdelivery.payload = void 0;\n\t\tsubagent.suppressCompletionDelivery = true;\n\t\tsubagent.requesterSettleWake = void 0;\n\t\tsubagent.wakeOnDescendantSettle = void 0;\n\t\tprojectedTask.deliveryStatus = "dismissed";\n\t\tprojectedTask.lastEventAt = now;\n\t} else if (outcome === "recovered") {\n\t\tObject.assign(delivery, {`,
    "intentional completion settlement"),
  (source) => replaceOnce(source,
    `export { settleCorrelatedSubagentDelivery as a, retrySubagentCompletionDelivery as i, dismissSubagentCompletionDelivery as n, resolveCorrelatedSubagentDelivery as r, admitCorrelatedSubagentSessionDelivery as t };`,
    `export { settleCorrelatedSubagentDelivery as a, retrySubagentCompletionDelivery as i, dismissSubagentCompletionDelivery as n, resolveCorrelatedSubagentDelivery as r, shouldSuppressCorrelatedSubagentDelivery as s, admitCorrelatedSubagentSessionDelivery as t };`,
    "completion fence export"),
]);

const sentinelFile = bundleContaining(/^server-restart-sentinel-.*\.js$/, "async function deliverQueuedSessionDelivery(params)", "restart sentinel");
const sentinelResult = patchFile(sentinelFile, [
  (source) => replaceOnce(source,
    `import { a as settleCorrelatedSubagentDelivery, r as resolveCorrelatedSubagentDelivery } from "./subagent-completion-delivery-`,
    `import { a as settleCorrelatedSubagentDelivery, r as resolveCorrelatedSubagentDelivery, s as shouldSuppressCorrelatedSubagentDelivery } from "./subagent-completion-delivery-`,
    "restart completion fence import"),
  (source) => replaceOnce(source,
    `async function deliverQueuedSessionDelivery(params) {\n\tconst queuedEntry = resolveCorrelatedSubagentDelivery(params.entry);`,
    `async function deliverQueuedSessionDelivery(params) {\n\tif (shouldSuppressCorrelatedSubagentDelivery(params.entry)) {\n\t\tawait settleCorrelatedSubagentDelivery(params.entry, "intentional_non_delivery");\n\t\treturn;\n\t}\n\tconst queuedEntry = resolveCorrelatedSubagentDelivery(params.entry);`,
    "pre-admission completion fence"),
]);

const announceFile = bundle(/^subagent-announce-delivery-.*\.js$/, "subagent announce delivery");
const announceResult = patchFile(announceFile, [
  (source) => replaceOnce(source,
    `import { m as clampTimerTimeoutMs } from`,
    `import { shouldSuppressConversationDelivery } from "./humanware-conversation-fence.mjs";\nimport { m as clampTimerTimeoutMs } from`,
    "announce fence import"),
  (source) => replaceOnce(source,
    `function sourceOwnerChangedResult() {\n\treturn {`,
    `function conversationClosedResult() {\n\treturn {\n\t\tdelivered: false,\n\t\tpath: "none",\n\t\treason: "conversation_closed",\n\t\terror: "target conversation is durably closed",\n\t\tterminal: true,\n\t\tdisposition: "intentional_non_delivery"\n\t};\n}\nfunction sourceOwnerChangedResult() {\n\treturn {`,
    "closed conversation delivery result"),
  (source) => replaceOnce(source,
    `async function deliverSubagentAnnouncement(params) {\n\tconst sourceOwnerChanged = () => params.isSourceSessionEffectsAllowed?.() === false;`,
    `async function deliverSubagentAnnouncement(params) {\n\tif (params.expectsCompletionMessage && shouldSuppressConversationDelivery({\n\t\tsessionKey: params.targetRequesterSessionKey ?? params.requesterSessionKey,\n\t\torigin: params.completionDirectOrigin ?? params.directOrigin ?? params.requesterOrigin\n\t}, { workCreatedAt: params.startedAt })) return conversationClosedResult();\n\tconst sourceOwnerChanged = () => params.isSourceSessionEffectsAllowed?.() === false;`,
    "pre-model completion fence"),
]);

const settleFile = bundle(/^subagent-announce\.requester-settle-wake-.*\.js$/, "requester settle wake");
const settleResult = patchFile(settleFile, [
  (source) => replaceOnce(source,
    `import { r as truncateUtf16Safe } from`,
    `import { shouldSuppressConversationDelivery } from "./humanware-conversation-fence.mjs";\nimport { r as truncateUtf16Safe } from`,
    "settle fence import"),
  (source) => replaceOnce(source,
    `\tconst batchRunIds = settledBatch.map((entry) => entry.runId).toSorted();\n\tconst selectedState = readSharedBatchState(settledBatch);\n\tif (hasUnsettledDescendants) {`,
    `\tconst suppressedBatch = settledBatch.filter((entry) => shouldSuppressConversationDelivery({\n\t\tsessionKey: requesterSessionKey,\n\t\torigin: params.requesterOrigin\n\t}, { workCreatedAt: entry.createdAt }));\n\tif (suppressedBatch.length > 0) completeRequesterSettleWakeBatch({\n\t\trunIds: suppressedBatch.map((entry) => entry.runId).toSorted(),\n\t\tstate: readSharedBatchState(suppressedBatch),\n\t\tcompleteBatch,\n\t\tdelivery: {\n\t\t\tdelivered: false,\n\t\t\tpath: "none",\n\t\t\treason: "conversation_closed",\n\t\t\terror: "target conversation is durably closed",\n\t\t\tdisposition: "intentional_non_delivery"\n\t\t}\n\t});\n\tsettledBatch = settledBatch.filter((entry) => !suppressedBatch.includes(entry));\n\tif (settledBatch.length === 0) return false;\n\tconst batchRunIds = settledBatch.map((entry) => entry.runId).toSorted();\n\tconst selectedState = readSharedBatchState(settledBatch);\n\tif (hasUnsettledDescendants) {`,
    "pre-admission settle fence"),
]);

const admissionFile = bundle(/^subagent-completion-admission\.store-.*\.js$/, "completion admission store");
const admissionResult = patchFile(admissionFile, [
  (source) => replaceOnce(source,
    `\t\tconst delivery = ensureDeliveryState(subagent);\n\t\tdelivery.payload ??= loadPendingFinalDeliveryPayload(subagent);\n\t\tObject.assign(delivery, {`,
    `\t\tconst delivery = ensureDeliveryState(subagent);\n\t\tdelivery.payload ??= loadPendingFinalDeliveryPayload(subagent);\n\t\tif (params.disposition === "intentional_non_delivery") {\n\t\t\tObject.assign(delivery, {\n\t\t\t\tstatus: "not_required",\n\t\t\t\tdisposition: "intentional_non_delivery",\n\t\t\t\tlastError: params.reason,\n\t\t\t\tdeliveredAt: void 0,\n\t\t\t\tannouncedAt: void 0,\n\t\t\t\tnextAttemptAt: void 0,\n\t\t\t\tqueueId: void 0,\n\t\t\t\tpayload: void 0\n\t\t\t});\n\t\t\tObject.assign(subagent, { cleanupHandled: false, wakeOnDescendantSettle: void 0, suppressCompletionDelivery: true });\n\t\t\tObject.assign(task, { deliveryStatus: "dismissed", lastEventAt: now });\n\t\t\tsettleSubagentCompletionDelivery({ subagent, task, databaseOptions: { database } });\n\t\t\tdeferSqlitePostCommitPublication(database.db, () => publishCommittedRecords(subagent, task));\n\t\t\treturn true;\n\t\t}\n\t\tObject.assign(delivery, {`,
    "intentional non-delivery bookkeeping"),
]);

const registryFile = bundleContaining(/^subagent-registry-[A-Z0-9_].*\.js$/, "isCompletionOwnedByRequesterYield", "subagent registry");
const registrySource = fs.readFileSync(registryFile, "utf8");
for (const marker of [
  `entry.suppressCompletionDelivery = killReconciliation.suppressTaskDelivery === true`,
  `skipRequesterSettleWake: skipRequesterDelivery`,
  `isCompletionOwnedByRequesterYield: () => entry.requesterTurnYielded === true || entry.requesterSettleWake?.requesterYieldBatch === true`,
  `requesterYieldBatch: true`,
]) {
  if (!registrySource.includes(marker)) throw new Error(`Required reviewed subagent lifecycle invariant is missing: ${marker}`);
}

console.log(JSON.stringify({
  helper: path.basename(helperTarget),
  completionResult,
  sentinelResult,
  announceResult,
  settleResult,
  admissionResult,
}));
