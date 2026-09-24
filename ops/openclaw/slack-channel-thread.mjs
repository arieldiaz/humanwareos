const MAX_ROOT_LENGTH = 160;

export function normalizeWorkThreadTitle(value) {
  const title = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (!title) throw new Error("title is required");
  if (title.length <= MAX_ROOT_LENGTH) return title;
  return `${title.slice(0, MAX_ROOT_LENGTH - 1).trimEnd()}…`;
}

// Routing facts, never body parsing or a title-generation turn.
export function planSlackChannelThread(params) {
  if (params.slackChannelThread) return params.slackChannelThread;
  if (params.deliveryQueueId) return; // Never reinterpret pre-upgrade queued sends.
  if (!params.session?.agentId && !params.mirror?.agentId) return;
  if (params.channel !== "slack" || params.session?.conversationType === "direct") return;
  const target = String(params.to ?? "").trim();
  const channelTarget = target.match(/^(?:team:T[A-Z0-9]+:)?channel:([^:]+)$/iu)?.[1] ?? target.replace(/^#/u, "");
  if (!channelTarget || /^[@<]|:/u.test(channelTarget) || /^[DUW][A-Z0-9]+$/u.test(channelTarget) || /^[duw][0-9][a-z0-9]{7,}$/u.test(channelTarget)) return;
  if (params.threadId || params.reply?.replyToId || params.replyToId || (params.payloads ?? []).some((payload) => payload.replyToId)) return;
  return { title: normalizeWorkThreadTitle(params.title || params.session?.title || params.session?.label || "Update") };
}

export function slackThreadBodyEntry(entry, rootMessageId, claimId) {
  if (!rootMessageId) throw new Error("Slack root send returned no messageId");
  return {
    ...entry,
    slackChannelThread: { ...entry.slackChannelThread, rootMessageId: String(rootMessageId) },
    threadId: String(rootMessageId),
    effectiveReplyToId: undefined,
    platformSendStartedAt: undefined,
    platformSendAttemptId: undefined,
    producerClaimId: claimId,
    recoveryState: claimId ? "producer_claimed" : undefined,
    availableAt: claimId ? entry.availableAt : undefined,
  };
}

export function slackThreadReconciliationContext(entry, context) {
  if (!entry.slackChannelThread || entry.slackChannelThread.rootMessageId) return context;
  return {
    ...context,
    queueId: `${entry.id}:slack-root`,
    payloads: [{ text: entry.slackChannelThread.title }],
    renderedBatchPlan: undefined,
    threadId: undefined,
    replyToId: undefined,
    effectiveReplyToId: undefined,
  };
}
