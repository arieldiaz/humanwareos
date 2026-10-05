import fs from "node:fs";
import path from "node:path";

const root = process.env.OPENCLAW_PACKAGE_ROOT || "/opt/homebrew/lib/node_modules/openclaw";
const dist = process.env.OPENCLAW_CORE_DIST || path.join(root, "dist");
if (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version !== "2026.9.1") throw new Error("Final receipts require reviewed OpenClaw 2026.9.1");
// The retired synthetic-root edits were made in place; only a reinstall removes them.
if (fs.existsSync(path.join(dist, "humanware-slack-channel-thread.mjs"))) throw new Error("Retired Slack channel-thread edits are installed; reinstall openclaw@2026.9.1, then rerun the patch runner");
const pending = new Map();
function edit(file, before, after) {
  const source = pending.get(file) ?? fs.readFileSync(path.join(dist, file), "utf8");
  if (source.includes(after)) return pending.set(file, source);
  if (source.split(before).length !== 2) throw new Error(`${file}: final-receipt anchor changed`);
  pending.set(file, source.replace(before, after));
}
const delivery = "deliver-B6F55ipQ.js";
const storage = "delivery-queue-storage-BmsyhVaX.js";
const recovery = "delivery-queue-recovery-CAUTn65F.js";
const gateway = "send-BcPUy9RI.js";
const schema = "src-B9mb84px.js";
const custodyImport = 'import { recordFinalEnvelopeReceipt, completedFinalEnvelopeResults } from "./delivery-queue-storage-BmsyhVaX.js";\n';
for (const [file, anchor] of [[delivery, 'import "./src-vebZIeLe.js";'], [recovery, 'import { t as formatErrorMessage } from "./errors-u9zSVTak.js";']]) edit(file, anchor, custodyImport + anchor);
// Host-owned thread replies keep their platform receipt inside the existing bounded completion record.
edit(storage, '/** Persist a delivery entry before attempting send. Returns the entry ID. */', `// humanware:final-receipt queue custody; never a side journal.
export function recordFinalEnvelopeReceipt(id, result, stateDir, claimId) {
 if (!id?.startsWith("humanware-final:")) return;
 if (!claimId) throw new Error("Final receipt requires queue custody");
 updateQueuedDelivery(id, stateDir, entry => ({...entry, finalEnvelopeReceipt: {channel: result.channel, messageId: result.messageId}}), claimId);
}
export function completedFinalEnvelopeResults(id, stateDir) {
 if (!id?.startsWith("humanware-final:") || findDeliveryIntentOwner(id, stateDir)?.status !== "completed") return [];
 const receipt = loadDeliveryQueueEntry(OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir, "all")?.finalEnvelopeReceipt;
 return receipt ? [receipt] : [];
}
/** Persist a delivery entry before attempting send. Returns the entry ID. */`);
edit(delivery, 'if (params.reusePendingDeliveryIntent && isReusablePreparedDeliveryOwner(owner)) return [];', 'if (params.reusePendingDeliveryIntent && isReusablePreparedDeliveryOwner(owner)) return completedFinalEnvelopeResults(params.deliveryIntentId);');
edit(delivery, '\t\t\tdeliveredResults.push(result);\n\t\t\tif (queueId', '\t\t\tdeliveredResults.push(result);\n\t\t\trecordFinalEnvelopeReceipt(platformQueueId, result, platformQueueStateDir, producerClaimId);\n\t\t\tif (queueId');
edit(recovery, '\tconst payloadOutcomes = [];\n\tconst messageSentEvents = [];\n\tlet postSendState;', `	// Gateway runtime authority is process-local and cannot be recreated by recovery.
	// Reconciliation above may observe success; another dispatch needs the live caller.
	if (entry.id?.startsWith("humanware-final:")) {
		opts.log.info("Final delivery is awaiting its live runtime authority");
		return "failed";
	}
	const payloadOutcomes = [];
	const messageSentEvents = [];
	let postSendState;`);
edit(recovery, '\t\t\tconst result = buildReconciledSentResult(entry, reconciliation);', '\t\t\tconst result = buildReconciledSentResult(entry, reconciliation);\n\t\t\trecordFinalEnvelopeReceipt(entry.id, result, opts.stateDir, entry.platformSendAttemptId);');
edit("delivery-queue-sqlite-UMkZG5_l.js", '\tconst requestedRetention = loadDeliveryQueueEntry(queueName, id, stateDir)?.completionRetention;', '\tconst completedEntry = loadDeliveryQueueEntry(queueName, id, stateDir);\n\tconst requestedRetention = completedEntry?.completionRetention;');
edit("delivery-queue-sqlite-UMkZG5_l.js", '\t\tentry: projectDeliveryQueueTerminalEntry({\n\t\t\tid,\n\t\t\tretryCount: 0\n\t\t}, now, "completed", retention),', `		entry: {
			...projectDeliveryQueueTerminalEntry({ id, retryCount: 0 }, now, "completed", retention),
			...completedEntry?.finalEnvelopeReceipt ? {finalEnvelopeReceipt: completedEntry.finalEnvelopeReceipt} : {}
		},`);
// start_work_thread posts one ordinary top-level message even when called from inside a thread.
edit(schema, 'const SendParamsSchema = closedObject({\n\tto: NonEmptyString,', 'const SendParamsSchema = closedObject({\n\tto: NonEmptyString,\n\ttopLevel: Type.Optional(Type.Boolean()),');
edit(gateway, '\t\tconst replyToId = normalizeOptionalString(request.replyToId);\n\t\tconst threadId = normalizeOptionalString(request.threadId);', '\t\tconst replyToId = request.topLevel ? void 0 : normalizeOptionalString(request.replyToId);\n\t\tconst threadId = request.topLevel ? void 0 : normalizeOptionalString(request.threadId);');
edit(gateway, '\t\t\t\t\t\tcurrentSessionKey: providedSessionKey,', '\t\t\t\t\t\tcurrentSessionKey: request.topLevel ? void 0 : providedSessionKey,');
// Validate every anchor before touching any bundle. Reapplying verifies every edit.
for (const [file, source] of pending) fs.writeFileSync(path.join(dist, file), source);
console.log(JSON.stringify({ patch: "final-receipt", bundles: pending.size }));
