import { normalizeWorkThreadTitle } from "./slack-channel-thread.mjs";

function messageId(result) {
  return result?.messageId ?? result?.message?.id ?? result?.result?.messageId;
}

function sessionKey(result) {
  return result?.key ?? result?.sessionKey ?? result?.result?.key;
}

function runId(result) {
  return result?.runId ?? result?.result?.runId;
}

export async function startSlackWorkThread({
  accountId,
  agentId,
  channel,
  title,
  detail,
  group,
  parentSessionKey,
  operationId,
  send,
  prepareScaffold,
  setStatus,
  createSession,
}) {
  if (!accountId || !agentId || !channel || !detail || !operationId) {
    throw new Error("accountId, agentId, channel, detail, and operationId are required");
  }
  const rootText = normalizeWorkThreadTitle(title);
  const publication = await send({
    accountId,
    agentId,
    channel: "slack",
    to: `channel:${channel}`,
    title: rootText,
    message: String(detail).trim(),
    topLevel: true,
    idempotencyKey: `work-thread:${operationId}:publication`,
  });
  const rootMessageId = publication?.threadId ?? publication?.result?.threadId;
  const replyMessageId = messageId(publication);
  if (!rootMessageId || !replyMessageId) throw new Error("Slack publication returned no root/body identity");
  await prepareScaffold({ channel, messageIds: [String(rootMessageId), String(replyMessageId)] });
  await setStatus({ channel, rootMessageId: String(rootMessageId), status: "working" });
  try {
    const task = [
      "Begin this work now.",
      `Use Slack channel ${channel}, thread root ${rootMessageId} for material progress, questions, and the final result.`,
      "The root and detailed brief are already posted; do not repeat or recreate them.",
      "",
      String(detail).trim(),
    ].join("\n");
    const session = await createSession({
      agentId,
      label: rootText,
      ...(group?.trim() ? { category: group.trim() } : {}),
      thinkingLevel: "high",
      task,
      ...(parentSessionKey ? { parentSessionKey } : {}),
      idempotencyKey: `work-thread:${operationId}:session`,
    });
    const childSessionKey = sessionKey(session);
    const childRunId = runId(session);
    if (!childSessionKey || session?.runStarted === false || !childRunId) {
      throw new Error(session?.runError?.message ?? session?.runError ?? "work session did not start");
    }
    return {
      rootMessageId: String(rootMessageId),
      replyMessageId: String(replyMessageId),
      childSessionKey: String(childSessionKey),
      runId: String(childRunId),
      thinkingLevel: "high",
    };
  } catch (error) {
    await setStatus({ channel, rootMessageId: String(rootMessageId), status: "act" });
    throw error;
  }
}
