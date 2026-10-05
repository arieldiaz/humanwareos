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
  const brief = String(detail).trim();
  // No sessionKey or threadId: stock gateway send posts top-level; the work session replies in its thread.
  const publication = await send({
    accountId,
    agentId,
    channel: "slack",
    to: `channel:${channel}`,
    message: brief,
    idempotencyKey: `work-thread:${operationId}:publication`,
  });
  const rootMessageId = messageId(publication);
  if (!rootMessageId) throw new Error("Slack publication returned no message identity");
  await prepareScaffold({ channel, messageIds: [String(rootMessageId)] });
  await setStatus({ channel, rootMessageId: String(rootMessageId), status: "working" });
  try {
    const task = [
      "Begin this work now.",
      `Use Slack channel ${channel}, thread root ${rootMessageId} for material progress, questions, and the final result.`,
      "The brief is already posted as the thread root; do not repeat or recreate it.",
      "",
      brief,
    ].join("\n");
    const session = await createSession({
      agentId,
      label: brief.split("\n")[0],
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
      childSessionKey: String(childSessionKey),
      runId: String(childRunId),
      thinkingLevel: "high",
    };
  } catch (error) {
    await setStatus({ channel, rootMessageId: String(rootMessageId), status: undefined });
    throw error;
  }
}
