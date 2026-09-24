import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.OPENCLAW_PACKAGE_ROOT || "/opt/homebrew/lib/node_modules/openclaw";
const dist = process.env.OPENCLAW_CORE_DIST || path.join(root, "dist");
if (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version !== "2026.9.1") throw new Error("Slack channel threads require reviewed OpenClaw 2026.9.1");
const pending = new Map();
const reapplied = fs.existsSync(path.join(dist, "humanware-slack-channel-thread.mjs"));
function edit(file, before, after) {
  const source = pending.get(file) ?? fs.readFileSync(path.join(dist, file), "utf8");
  if (source.includes(after)) return pending.set(file, source);
  if (reapplied || source.split(before).length !== 2) throw new Error(`${file}: Slack channel-thread anchor changed`);
  pending.set(file, source.replace(before, after));
}
const delivery = "deliver-B6F55ipQ.js";
const storage = "delivery-queue-storage-BmsyhVaX.js";
const recovery = "delivery-queue-recovery-CAUTn65F.js";
const reconciliation = "delivery-queue-reconciliation-DMcA7z0l.js";
const gateway = "send-BcPUy9RI.js";
const schema = "src-B9mb84px.js";
const helperImport = 'import { planSlackChannelThread, slackThreadBodyEntry, slackThreadReconciliationContext } from "./humanware-slack-channel-thread.mjs";\n';
for (const [file, region] of [[delivery, "src/infra/outbound/deliver-queue-admission.ts"], [storage, "src/infra/delivery-queue-sqlite-claim.ts"], [reconciliation, "src/infra/outbound/deliver-payload.ts"]]) {
  edit(file, `//#region ${region}`, helperImport + `//#region ${region}`);
}
const custodyImport = 'import { checkpointSlackThreadRoot, recoverSlackThreadRoot, recordSlackThreadBodyResult, completedSlackThreadResults } from "./delivery-queue-storage-BmsyhVaX.js";\n';
for (const [file, anchor] of [[delivery, 'import "./src-vebZIeLe.js";'], [recovery, 'import { t as formatErrorMessage } from "./errors-u9zSVTak.js";']]) edit(file, anchor, custodyImport + anchor);
edit(storage, '/** Persist a delivery entry before attempting send. Returns the entry ID. */', `// humanware:slack-channel-thread queue custody; never a side journal.
export function checkpointSlackThreadRoot(id, rootMessageId, stateDir, claimId) {
	if (!claimId) throw new Error("Slack thread publication requires queue ownership");
	updateQueuedDelivery(id, stateDir, (entry) => slackThreadBodyEntry(entry, rootMessageId, claimId), claimId);
}
export function recoverSlackThreadRoot(entry, rootMessageId, stateDir) {
	const replacementEntry = slackThreadBodyEntry(entry, rootMessageId);
	return replacePendingDeliveryQueueEntry({ queueName: OUTBOUND_DELIVERY_QUEUE_NAME, expectedEntry: entry, replacementEntry, stateDir }) ? replacementEntry : null;
}
export function recordSlackThreadBodyResult(id, result, stateDir, claimId) {
	updateQueuedDelivery(id, stateDir, (entry) => entry.slackChannelThread ? { ...entry, slackChannelThread: { ...entry.slackChannelThread, result } } : entry, claimId);
}
export function completedSlackThreadResults(id, stateDir) {
	if (findDeliveryIntentOwner(id, stateDir)?.status !== "completed") return [];
	const entry = loadDeliveryQueueEntry(OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir, "all");
	return entry?.slackChannelThread?.result ? [entry.slackChannelThread.result] : [];
}
/** Persist a delivery entry before attempting send. Returns the entry ID. */`);
edit(storage, '\t\tthreadId: params.threadId,\n\t\treply: params.reply,', '\t\tslackChannelThread: params.slackChannelThread,\n\t\tthreadId: params.threadId,\n\t\treply: params.reply,');
edit(delivery, '\t\t\tthreadId: params.threadId,\n\t\t\treply: normalizeOutboundReplyFacts(params),', '\t\t\tslackChannelThread: params.slackChannelThread ?? planSlackChannelThread({ ...params, payloads: acceptedPayloads }),\n\t\t\tthreadId: params.threadId,\n\t\t\treply: normalizeOutboundReplyFacts(params),');
edit(recovery, '\t\tthreadId: entry.threadId,\n\t\treply: entry.reply,', '\t\tslackChannelThread: entry.slackChannelThread,\n\t\tthreadId: entry.threadId,\n\t\treply: entry.reply,');
edit(delivery, '\tconst params = {\n\t\t...currentParams,\n\t\t...reply ? { reply } : {}\n\t};', `	const queuedThread = currentParams.deliveryQueueId ? (await loadPendingDelivery(currentParams.deliveryQueueId, currentParams.deliveryQueueStateDir))?.slackChannelThread : void 0;
	const slackChannelThread = queuedThread ?? planSlackChannelThread({ ...currentParams, reply });
	const params = {
		...currentParams,
		...reply ? { reply } : {},
		...slackChannelThread ? {
			slackChannelThread,
			queuePolicy: "required",
			reusePendingDeliveryIntent: true,
			// Recovery already owns this queue row. Fresh sends must acquire custody.
			skipQueue: currentParams.deliveryQueueId ? currentParams.skipQueue : false
		} : {}
	};`);
edit(delivery, '\t\t...custody,\n\t\tpayloads', '\t\t...custody,\n\t\tslackChannelThread: entry.slackChannelThread,\n\t\tpayloads');
edit(delivery, 'if (params.reusePendingDeliveryIntent && isReusablePreparedDeliveryOwner(owner)) return [];', 'if (params.reusePendingDeliveryIntent && isReusablePreparedDeliveryOwner(owner)) return completedSlackThreadResults(params.deliveryIntentId);');
edit(delivery, '\tlet platformSendStarted = false;\n\tlet platformSendRoute;', '\tlet rootPending = Boolean(params.slackChannelThread && !params.slackChannelThread.rootMessageId && params.payloads.length > 0);\n\tlet platformSendStarted = false;\n\tlet platformSendRoute;');
edit(delivery, '\t\t\tawait params.onPlatformSendStart?.(route);', '\t\t\tif (!rootPending) await params.onPlatformSendStart?.(route);');
edit(delivery, '\t\t\tdeliveredResults.push(result);\n\t\t\tif (queueId', '\t\t\tdeliveredResults.push(result);\n\t\t\tif (params.slackChannelThread) recordSlackThreadBodyResult(platformQueueId, result, platformQueueStateDir, producerClaimId);\n\t\t\tif (queueId');
edit(delivery, '\t\tconst results = await deliverOutboundPayloadsCore(wrappedParams);', `		if (rootPending) {
			if (!platformQueueId || !producerClaimId) throw new Error("Slack thread publication requires durable queue custody");
			const rootHandler = await createChannelHandler({
				cfg: params.cfg, channel: params.channel, to: params.to,
				agentId: params.session?.agentId, accountId: params.accountId,
				deps: params.deps, identity: params.identity, silent: params.silent,
				gatewayClientScopes: params.gatewayClientScopes,
				conversationReadOrigin: params.conversationReadOrigin,
				deliveryQueueId: platformQueueId + ":slack-root",
				requiredUnknownSendReconciliation: true,
				onPlatformSendStart: (route) => wrappedParams.onPlatformSendStart(route, 0),
				onPlatformSendDispatch: wrappedParams.onPlatformSendDispatch,
				onDirectAdapterHandoff: wrappedParams.onDirectAdapterHandoff,
				assertDirectAdapterHandoff: wrappedParams.assertDirectAdapterHandoff
			});
			const root = await rootHandler.sendText(params.slackChannelThread.title, {});
			throwIfProducerLeaseLost();
			checkpointSlackThreadRoot(platformQueueId, root.messageId, platformQueueStateDir, producerClaimId);
			wrappedParams.slackChannelThread = { ...params.slackChannelThread, rootMessageId: root.messageId };
			wrappedParams.threadId = root.messageId;
			rootPending = false;
			queuedPreSendState = void 0;
			platformSendStarted = false;
			platformSendRoute = void 0;
			platformSendSourceIndex = void 0;
			auditPlatformStartedPayloads.clear();
			platformDispatchedPayloads.clear();
		}
		const results = await deliverOutboundPayloadsCore(wrappedParams);
		if (wrappedParams.slackChannelThread?.rootMessageId && results.length === 0) throw new Error("Slack thread body returned no delivery identity");`);
edit(delivery, '\t\tif (isOutboundDeliveryAdmissionClosedError(err)) throw err;\n\t\tif (err instanceof OutboundDeliveryError', `		if (isOutboundDeliveryAdmissionClosedError(err)) throw err;
		if (rootPending) {
			// Root evidence is not body evidence, and may never settle the intent.
			if (queueId) await recordOwnedQueueFailure(isProvenDeliveryNotSentError(err) ? failDeliveryBeforePlatformSend : failDelivery, formatErrorMessage(err));
			throw err;
		}
		if (params.slackChannelThread && !platformSendStarted && isDeliveryAbortError(err)) {
			if (queueId) await recordOwnedQueueFailure(failDeliveryBeforePlatformSend, formatErrorMessage(err));
			throw err;
		}
		if (err instanceof OutboundDeliveryError`);
// Both live reuse and restart recovery consume the persisted body route.
edit(delivery, '\tconst deliveryParams = {\n\t\t...params,\n\t\tpayloads: preparedPayloads,', '\tconst deliveryParams = {\n\t\t...params,\n\t\t...params.slackChannelThread?.rootMessageId ? { threadId: params.slackChannelThread.rootMessageId } : {},\n\t\tpayloads: preparedPayloads,');
edit(reconciliation, '\treturn {\n\t\tcfg: params.cfg,\n\t\tqueueId: entry.id,', '\treturn slackThreadReconciliationContext(entry, {\n\t\tcfg: params.cfg,\n\t\tqueueId: entry.id,');
edit(reconciliation, '\t\t...entry.silent !== void 0 ? { silent: entry.silent } : {}\n\t};', '\t\t...entry.silent !== void 0 ? { silent: entry.silent } : {}\n\t});');
edit(recovery, '\t\tif (reconciliation?.status === "sent") try {', `		if (reconciliation?.status === "sent" && entry.slackChannelThread && !entry.slackChannelThread.rootMessageId) {
			// Exact root marker advances custody; it cannot acknowledge the body.
			const bodyEntry = recoverSlackThreadRoot(entry, reconciliation.messageId, opts.stateDir);
			if (!bodyEntry) return "already-gone";
			return drainQueuedEntry({ ...opts, entry: bodyEntry });
		}
		if (reconciliation?.status === "sent") try {`);
edit(recovery, '\t\t\tconst result = buildReconciledSentResult(entry, reconciliation);', '\t\t\tconst result = buildReconciledSentResult(entry, reconciliation);\n\t\t\tif (entry.slackChannelThread) recordSlackThreadBodyResult(entry.id, { ...result, threadId: entry.threadId, threadTs: entry.threadId }, opts.stateDir, entry.platformSendAttemptId);');
edit(gateway, '//#region src/gateway/server-methods/send.ts', 'import { planSlackChannelThread } from "./humanware-slack-channel-thread.mjs";\n//#region src/gateway/server-methods/send.ts');
edit(gateway, '\t\t\t\t\tconst send = await sendDurableMessageBatchCore({', `					const newSlackThread = planSlackChannelThread({ channel, to: deliveryTarget, session: outboundSession, payloads: outboundPayloads, replyToId, threadId: outboundRoute?.threadId ?? threadId });
					const send = await sendDurableMessageBatchCore({`);
edit("delivery-queue-sqlite-UMkZG5_l.js", '\tconst requestedRetention = loadDeliveryQueueEntry(queueName, id, stateDir)?.completionRetention;', '\tconst completedThreadEntry = loadDeliveryQueueEntry(queueName, id, stateDir);\n\tconst requestedRetention = completedThreadEntry?.completionRetention;');
edit("delivery-queue-sqlite-UMkZG5_l.js", '\t\tentry: projectDeliveryQueueTerminalEntry({\n\t\t\tid,\n\t\t\tretryCount: 0\n\t\t}, now, "completed", retention),', `		entry: {
			...projectDeliveryQueueTerminalEntry({ id, retryCount: 0 }, now, "completed", retention),
			// Retain only publication identities inside the existing bounded receipt.
			...completedThreadEntry?.slackChannelThread?.result ? { slackChannelThread: {
				rootMessageId: completedThreadEntry.slackChannelThread.rootMessageId,
				result: { channel: "slack", messageId: completedThreadEntry.slackChannelThread.result.messageId, threadTs: completedThreadEntry.slackChannelThread.rootMessageId }
			} } : {}
		},`);
// Existing producers supply title metadata; no new agent run or formatting mode.
edit("run-delivery.runtime-falxHVAy.js", '\t\t\t\t\tpayloads: linkedPayloadsForDelivery,', '\t\t\t\t\ttitle: params.job.name,\n\t\t\t\t\tpayloads: linkedPayloadsForDelivery,');
edit(schema, 'const SendParamsSchema = closedObject({\n\tto: NonEmptyString,', 'const SendParamsSchema = closedObject({\n\tto: NonEmptyString,\n\ttitle: Type.Optional(Type.String()),\n\ttopLevel: Type.Optional(Type.Boolean()),');
edit(gateway, '\t\t"conversationId",\n\t\t"pollId"', '\t\t"conversationId",\n\t\t"threadId",\n\t\t"threadTs",\n\t\t"pollId"');
edit(gateway, '\t\tconst replyToId = normalizeOptionalString(request.replyToId);\n\t\tconst threadId = normalizeOptionalString(request.threadId);', '\t\tconst replyToId = request.topLevel ? void 0 : normalizeOptionalString(request.replyToId);\n\t\tconst threadId = request.topLevel ? void 0 : normalizeOptionalString(request.threadId);');
edit(gateway, '\t\t\t\t\t\tcurrentSessionKey: providedSessionKey,', '\t\t\t\t\t\tcurrentSessionKey: request.topLevel ? void 0 : providedSessionKey,');
edit(gateway, '\t\t\t\t\t\tpayloads: outboundPayloads,', '\t\t\t\t\t\ttitle: request.title ?? (providedSessionKey ? loadGatewaySessionEntry(providedSessionKey).entry?.label : void 0),\n\t\t\t\t\t\t...newSlackThread ? { deliveryIntentId: `slack-send:${accountId}:${deliveryTarget}:${idem}`, reusePendingDeliveryIntent: true, completionRetention: { idPrefix: "slack-send:", maxAgeMs: 86400000, maxEntries: 2000 } } : {},\n\t\t\t\t\t\tpayloads: outboundPayloads,');
edit(gateway, '\t\t\t\t\tconst result = (send.status === "sent" ? send.results : []).at(-1);', '\t\t\t\t\tconst delivered = (send.status === "sent" ? send.results : []).at(-1);\n\t\t\t\t\tconst result = delivered ? { ...delivered, threadId: delivered.threadId ?? delivered.threadTs } : delivered;');
// Validate every anchor before touching any bundle. Reapplying verifies every edit.
const helper = fs.readFileSync(fileURLToPath(new URL("../slack-channel-thread.mjs", import.meta.url)), "utf8");
for (const [file, source] of pending) fs.writeFileSync(path.join(dist, file), source);
fs.writeFileSync(path.join(dist, "humanware-slack-channel-thread.mjs"), helper);
console.log(JSON.stringify({ patch: "slack-channel-thread", bundles: pending.size }));
