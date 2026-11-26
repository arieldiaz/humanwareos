import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

function words(value) {
  return String(value ?? "").trim().split(/\s+/).filter(Boolean).length;
}

export function formatElapsed(seconds) {
  const minutes = Math.max(0, Number(seconds) || 0) / 60;
  const hours = minutes / 60;
  if (hours >= 24 * 7) return `${Math.round(minutes)} min (open ${Math.round(hours / 24)} d)`;
  return `${Math.round(minutes)} min (${hours.toFixed(1)} h)`;
}

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

export function measureSlackThread(messages = []) {
  const ordered = messages.filter((message) => message?.ts).toSorted((a, b) => Number(a.ts) - Number(b.ts));
  if (!ordered.length) throw new Error("Slack returned no messages for the thread root");
  const human = ordered.filter((message) => !message.bot_id && !message.bot_profile);
  const agents = ordered.filter((message) => message.bot_id || message.bot_profile);
  return {
    elapsed: formatElapsed(Number(ordered.at(-1).ts) - Number(ordered[0].ts)),
    elapsedSeconds: Number(ordered.at(-1).ts) - Number(ordered[0].ts),
    topic: String(ordered[0].text ?? "").split("\n")[0].replace(/<[^|>]*\|([^>]*)>/g, "$1").trim().slice(0, 120),
    pullRequests: [...new Set(ordered.flatMap((message) => String(message.text ?? "").match(PR_URL) ?? []))],
    totalMessages: ordered.length,
    humanMessages: human.length,
    agentMessages: agents.length,
    humanWords: human.reduce((total, message) => total + words(message.text), 0),
    agentWords: agents.reduce((total, message) => total + words(message.text), 0),
  };
}

export async function loadPullRequests(urls = [], run = promisify(execFile)) {
  return Promise.all(urls.map(async (url) => {
    const number = Number(url.split("/").at(-1));
    try {
      const {stdout} = await run("gh", ["pr", "view", url, "--json", "number,state,additions,deletions,changedFiles"], {timeout: 10000});
      return {url, ...JSON.parse(stdout)};
    } catch {
      return {url, number};
    }
  }));
}

function compact(n) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
}

function duration(seconds) {
  const minutes = seconds / 60;
  return minutes < 60 ? `${Math.max(1, Math.round(minutes))}m` : minutes < 60 * 48 ? `${(minutes / 60).toFixed(1)}h` : `${Math.round(minutes / 1440)}d`;
}

// `usage` is the ledger roll-up session_records.py returns from the capture step: tokens by class and the
// API list-price equivalent priced by the session console's table. No usage never prints as zero.
export function usageLine(usage) {
  const tokens = usage?.tokens ?? {};
  if (!usage?.reports || !tokens.total) return "- Tokens: usage unavailable";
  const read = tokens.cacheRead ?? 0, fresh = tokens.total - tokens.output - read;
  const cached = fresh + read ? ` (${Math.round((100 * read) / (fresh + read))}% cached)` : "";
  const price = usage.amount == null ? "price unavailable" : `$${usage.amount.toFixed(2)} API list-price equivalent`;
  const unpriced = usage.unavailable && usage.amount != null ? `; ${usage.unavailable} of ${usage.reports} usage reports unpriced` : "";
  return `- Tokens: ${compact(fresh + read)} in${cached} · ${compact(tokens.output ?? 0)} out · ${price}${unpriced}`;
}

export function formatCloseReport({ stats, usage, followUps = [], pullRequests = [] }) {
  const header = ["**Session closed**", stats?.elapsedSeconds != null && duration(stats.elapsedSeconds), stats && `${stats.totalMessages} msgs`].filter(Boolean).join(" · ");
  const lines = [header];
  if (stats?.topic) lines.push(`- What: ${stats.topic}`);
  lines.push(usageLine(usage));
  if (pullRequests.length) lines.push(`- Code: ${pullRequests.map(pr => [`[PR #${pr.number}](${pr.url})`, pr.state?.toLowerCase(),
    pr.additions != null && `+${pr.additions}/−${pr.deletions}`, pr.changedFiles != null && `${pr.changedFiles} files`].filter(Boolean).join(" · ")).join("; ")}`);
  lines.push(`- Follow-up: ${followUps.length ? followUps.join("; ") : "none"}`);
  return lines.join("\n");
}

// Slack posts the report straight through chat.postMessage, which reads mrkdwn, not Markdown.
export function slackMrkdwn(markdown) {
  return String(markdown ?? "").replace(/\*\*(.+?)\*\*/g, "*$1*").replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "<$2|$1>").replace(/^- /gm, "• ");
}

export async function loadSlackThreadSnapshot({channel, threadId, latest, token, call, limit = 200}) {
  const messages = [];
  let cursor;
  do {
    const page = await call("conversations.replies", token, {channel, ts: threadId, latest, inclusive: true, limit, ...(cursor ? {cursor} : {})});
    messages.push(...(page.messages ?? []).filter(message => Number(message.ts) <= Number(latest)));
    cursor = page.response_metadata?.next_cursor;
    if (page.has_more && !cursor) throw new Error("Incomplete thread evidence without a continuation cursor");
  } while (cursor);
  return messages;
}

export async function recordSessionClose({ dataRoot, channel, thread, agent, summary, stats, usage, operationId, now = new Date() }) {
  const ts = now.toISOString();
  const logicalSessionId = `slack:${channel}:${thread}`;
  const id = operationId;
  const event = {
    schemaVersion: 2,
    id,
    traceId: id,
    ts,
    logicalSessionId,
    runtimeSessionId: null,
    agent,
    source: "slack",
    kind: "session.completed",
    level: "normal",
    summary,
    details: { channelId: channel, threadId: thread, threadStats: stats, usage: usage ?? null },
    sourceRef: { sessionKey: logicalSessionId, messageId: thread },
  };
  const eventsPath = join(dataRoot, "evidence", "sessions", "events", `${ts.slice(0, 10)}.jsonl`);
  await mkdir(dirname(eventsPath), { recursive: true });
  let prior = "";
  try {
    prior = await readFile(eventsPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!prior.includes(`\"id\":\"${id}\"`)) await appendFile(eventsPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  return event;
}
