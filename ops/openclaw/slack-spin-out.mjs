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
  summary,
  detail,
  group,
  operationId,
  send,
  prepareScaffold,
  createSession,
}) {
  const heading = String(title ?? "").trim().split("\n")[0];
  const overview = String(summary ?? "").trim();
  const brief = String(detail ?? "").trim();
  if (!accountId || !agentId || !channel || !heading || !overview || !brief || !operationId) {
    throw new Error("accountId, agentId, channel, title, summary, detail, and operationId are required");
  }
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
  await send({
    accountId,
    agentId,
    channel: "slack",
    to: `channel:${channel}`,
    threadId: String(rootMessageId),
    message: overview,
    idempotencyKey: `work-thread:${operationId}:summary`,
  });
  await prepareScaffold({ channel, messageIds: [String(rootMessageId)] });
  const task = [
    "Begin this work now.",
    `Report in Slack channel ${channel}, thread root ${rootMessageId}: one report per milestone, decision, or blocker, then the final result. No interim progress posts.`,
    `The title "${heading}" is the thread root and a short summary for the human is its first reply; do not repeat either. The brief below is not posted in Slack.`,
    "",
    brief,
  ].join("\n");
  const session = await createSession({
    accountId,
    channel,
    rootMessageId: String(rootMessageId),
    label: heading,
    ...(group?.trim() ? { category: group.trim() } : {}),
    task,
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
  };
}
