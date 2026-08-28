import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

function words(value) {
  return String(value ?? "").trim().split(/\s+/).filter(Boolean).length;
}

export function formatElapsed(seconds) {
  const minutes = Math.max(0, Number(seconds) || 0) / 60;
  const hours = minutes / 60;
  if (hours >= 24 * 7) return `${Math.round(minutes)} min (open ${Math.round(hours / 24)} d)`;
  return `${Math.round(minutes)} min (${hours.toFixed(1)} h)`;
}

export function measureSlackThread(messages = []) {
  const ordered = messages.filter((message) => message?.ts).toSorted((a, b) => Number(a.ts) - Number(b.ts));
  if (!ordered.length) throw new Error("Slack returned no messages for the thread root");
  const human = ordered.filter((message) => !message.bot_id && !message.bot_profile);
  const agents = ordered.filter((message) => message.bot_id || message.bot_profile);
  return {
    elapsed: formatElapsed(Number(ordered.at(-1).ts) - Number(ordered[0].ts)),
    totalMessages: ordered.length,
    humanMessages: human.length,
    agentMessages: agents.length,
    humanWords: human.reduce((total, message) => total + words(message.text), 0),
    agentWords: agents.reduce((total, message) => total + words(message.text), 0),
  };
}

export function summarizeTrajectory(source = "") {
  const totals = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, peakContext: 0 };
  const models = new Map();
  for (const line of String(source).split("\n")) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const completed = entry?.type === "model.completed";
    const assistant = entry?.type === "message" && entry?.message?.role === "assistant" && entry?.message?.usage;
    if (!completed && !assistant) continue;
    const usage = completed ? entry?.data?.usage ?? {} : entry.message.usage;
    totals.turns += 1;
    totals.input += Number(usage.input) || 0;
    totals.output += Number(usage.output) || 0;
    totals.cacheRead += Number(usage.cacheRead) || 0;
    totals.cacheWrite += Number(usage.cacheWrite) || 0;
    totals.peakContext = Math.max(totals.peakContext,
      (Number(usage.input) || 0) + (Number(usage.cacheRead) || 0) + (Number(usage.cacheWrite) || 0));
    const model = String(entry.modelId ?? entry?.message?.model ?? "model unrecorded");
    models.set(model, (models.get(model) ?? 0) + 1);
  }
  if (!totals.turns) return;
  return {
    ...totals,
    models: [...models].map(([model, count]) => count === 1 ? model : `${model} (${count} runs)`).join(", "),
  };
}

export async function loadThreadUsage({ agent, channel, thread, agentsRoot = join(homedir(), ".openclaw", "agents") }) {
  const sessionsDir = join(agentsRoot, agent, "sessions");
  let index;
  try {
    index = JSON.parse(await readFile(join(sessionsDir, "sessions.json"), "utf8"));
  } catch {
    return;
  }
  const key = `agent:${agent}:slack:channel:${String(channel).toLowerCase()}:thread:${thread}`;
  const sessionId = index[key]?.sessionId;
  if (!sessionId) return;
  let candidates;
  try {
    const paths = (await readdir(sessionsDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.startsWith(sessionId) && entry.name.endsWith(".jsonl"))
      .map((entry) => join(sessionsDir, entry.name));
    candidates = await Promise.all(paths.map(async (path) => ({ path, modified: (await stat(path)).mtimeMs })));
    candidates.sort((a, b) => b.modified - a.modified);
  } catch {
    return;
  }
  for (const candidate of candidates) {
    const usage = summarizeTrajectory(await readFile(candidate.path, "utf8"));
    if (usage) return usage;
  }
}

export function closeSummary(content, ownerLabel = "the human") {
  const source = String(content ?? "").replace(/(?:^|\n)## Session Closed[\s\S]*$/i, "").trim();
  return source || `Closed at ${ownerLabel}'s request.`;
}

export function formatCloseOut({ summary, stats, usage, agent, ownerLabel = "the human" }) {
  const name = String(agent || "agent").replace(/^./, (value) => value.toUpperCase());
  const compactSummary = String(summary).trim().replace(/\s+/g, " ");
  const lines = [
    "## Session Closed",
    `- Summary: ${compactSummary}`,
    `- Elapsed: ${stats.elapsed}`,
    `- Messages: ${stats.humanMessages} from ${ownerLabel} / ${stats.agentMessages} from agents`,
    `- Words: ${stats.humanWords.toLocaleString("en-US")} from ${ownerLabel} / ${stats.agentWords.toLocaleString("en-US")} from agents`,
  ];
  if (usage) {
    const processed = usage.input + usage.cacheRead + usage.cacheWrite;
    lines.push(`- Runtime: ${name} · ${usage.models} · ${usage.turns} completed model turn${usage.turns === 1 ? "" : "s"}`);
    lines.push(`- Input processed: ${processed.toLocaleString("en-US")} tokens (${usage.cacheRead.toLocaleString("en-US")} cache read, ${usage.cacheWrite.toLocaleString("en-US")} cache write, ${usage.input.toLocaleString("en-US")} fresh)`);
    if (usage.peakContext) lines.push(`- Context peak: ${usage.peakContext.toLocaleString("en-US")} tokens`);
    lines.push(usage.output >= stats.agentWords
      ? `- Tokens out: ${usage.output.toLocaleString("en-US")}`
      : `- Tokens out: unavailable (provider counter incomplete: ${usage.output.toLocaleString("en-US")})`);
  } else {
    lines.push(`- Runtime: ${name} · usage unavailable because this harness recorded no completed model-usage event for the thread`);
  }
  return lines.join("\n");
}

export async function recordSessionClose({ dataRoot, channel, thread, agent, closeMessageId, summary, stats, usage, ownerLabel, now = new Date() }) {
  const ts = now.toISOString();
  const logicalSessionId = `slack:${channel}:${thread}`;
  const id = `session-completed:${channel}:${thread}:${closeMessageId}`;
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
    details: { channelId: channel, threadId: thread, closeMessageId, threadStats: stats, usage: usage ?? null },
    sourceRef: { sessionKey: logicalSessionId, messageId: closeMessageId },
  };
  const eventsPath = join(dataRoot, "evidence", "sessions", "events", `${ts.slice(0, 10)}.jsonl`);
  const viewName = createHash("sha256").update(logicalSessionId).digest("hex").slice(0, 24);
  const viewPath = join(dataRoot, "generated", "sessions", `${viewName}.md`);
  await mkdir(dirname(eventsPath), { recursive: true });
  await mkdir(dirname(viewPath), { recursive: true });
  let prior = "";
  try {
    prior = await readFile(eventsPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!prior.includes(`\"id\":\"${id}\"`)) await appendFile(eventsPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  await writeFile(viewPath, `${formatCloseOut({ summary, stats, usage, agent, ownerLabel })}\n`, { mode: 0o600 });
  return { event, viewPath };
}
