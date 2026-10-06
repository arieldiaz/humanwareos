function messageId(result) {
  return result?.messageId ?? result?.message?.id ?? result?.result?.messageId;
}

function sessionKey(result) {
  return result?.key ?? result?.sessionKey ?? result?.result?.key;
}

function runId(result) {
  return result?.runId ?? result?.result?.runId;
}

const normalize = (value) => String(value ?? "").toLowerCase().replace(/^#/, "").replace(/[^a-z0-9]+/g, " ").trim();

function score(query, name) {
  const q = normalize(query);
  const n = normalize(name);
  if (!q || !n) return 0;
  if (q === n) return 100;
  if (n.replace(/ /g, "") === q.replace(/ /g, "")) return 95;
  if (n.startsWith(q)) return 80;
  if (n.includes(q)) return 70;
  const words = q.split(" ");
  const hits = words.filter((word) => n.includes(word)).length;
  return hits ? Math.round((50 * hits) / words.length) : 0;
}

// Resolves a channel by ID or loose name against the channels the bot can see. The best unique match wins; only a tie fails.
export function matchSlackChannel(query, channels) {
  const raw = String(query ?? "").trim().replace(/^channel:/i, "");
  if (/^[CG][A-Z0-9]{6,}$/i.test(raw)) return raw.toUpperCase();
  const ranked = channels
    .map((channel) => ({ ...channel, score: score(raw, channel.name) }))
    .filter((channel) => channel.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) throw new Error(`No Slack channel matches "${raw}"`);
  const best = ranked.filter((channel) => channel.score === ranked[0].score);
  if (best.length > 1) throw new Error(`"${raw}" matches several channels: ${best.map((c) => `#${c.name}`).join(", ")}`);
  return best[0].id;
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
  if (!accountId || !agentId || !channel || !title || !detail || !operationId) {
    throw new Error("accountId, agentId, channel, title, detail, and operationId are required");
  }
  const heading = String(title).trim().split("\n")[0];
  const brief = String(detail).trim();
  // No sessionKey or threadId: stock gateway send posts top-level; the work session replies in its thread.
  const publication = await send({
    accountId,
    agentId,
    channel: "slack",
    to: `channel:${channel}`,
    message: heading,
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
      `The thread root is the title "${heading}"; do not repeat or recreate it.`,
      "",
      brief,
    ].join("\n");
    const session = await createSession({
      agentId,
      label: heading,
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
