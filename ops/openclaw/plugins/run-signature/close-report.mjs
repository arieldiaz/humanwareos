import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {defaultAgentsRoot, loadSessionEntry, withCanonicalSessionDatabase} from "./session-store.mjs";

function words(value) {
  return String(value ?? "").trim().split(/\s+/).filter(Boolean).length;
}

export function formatElapsed(seconds) {
  const minutes = Math.max(0, Number(seconds) || 0) / 60;
  const hours = minutes / 60;
  if (hours >= 24 * 7) return `${Math.round(minutes)} min (open ${Math.round(hours / 24)} d)`;
  return `${Math.round(minutes)} min (${hours.toFixed(1)} h)`;
}

// USD per million tokens when the OpenClaw model config has no price (subscription runtimes record $0).
const FALLBACK_PRICES = {
  "claude-opus-5-5": {input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5},
  "claude-opus-5": {input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25},
};
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

export function summarizeTrajectory(source = "", {before = Infinity} = {}) {
  const totals = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, peakContext: 0 };
  const coverage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, peakContext: 0};
  const models = new Map();
  const byModel = {};
  const entries = typeof source === "string" ? source.split("\n").flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }) : source;
  const seen = new Set();
  for (const entry of entries) {
    if (entry?.id) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
    }
    const recordedAt = entry.ts ?? entry.timestamp ?? entry.message?.timestamp;
    const timestamp = typeof recordedAt === 'number' ? recordedAt : Date.parse(recordedAt);
    if (Number.isFinite(before) && (!Number.isFinite(timestamp) || timestamp > before)) continue;
    const completed = entry?.type === "model.completed";
    const assistant = entry?.type === "message" && entry?.message?.role === "assistant" && entry?.message?.usage;
    if (!completed && !assistant) continue;
    const usage = completed ? entry?.data?.usage ?? {} : entry.message.usage;
    totals.turns += 1;
    for (const field of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      if (Number.isFinite(usage[field]) && usage[field] >= 0) { totals[field] += usage[field]; coverage[field]++; }
    }
    if (['input', 'cacheRead', 'cacheWrite'].every(field => Number.isFinite(usage[field]))) {
      coverage.peakContext++;
      totals.peakContext = Math.max(totals.peakContext, usage.input + usage.cacheRead + usage.cacheWrite);
    }
    const model = String(entry.modelId ?? entry?.message?.model ?? "model unrecorded");
    models.set(model, (models.get(model) ?? 0) + 1);
    byModel[model] ??= {input: 0, output: 0, cacheRead: 0, cacheWrite: 0};
    for (const field of Object.keys(byModel[model])) if (Number.isFinite(usage[field]) && usage[field] >= 0) byModel[model][field] += usage[field];
  }
  if (!totals.turns) return;
  return {
    ...totals, coverage, byModel,
    models: [...models].map(([model, count]) => count === 1 ? model : `${model} (${count} runs)`).join(", "),
  };
}

export async function loadThreadUsage({ agent, channel, thread, agentsRoot = defaultAgentsRoot(), before = Infinity }) {
  const sessionsDir = join(agentsRoot, agent, "sessions");
  const key = `agent:${agent}:slack:channel:${String(channel).toLowerCase()}:thread:${thread}`;
  const canonical = await withCanonicalSessionDatabase({agent, agentsRoot}, (database) => {
    const compressed = database.prepare("SELECT 1 FROM pragma_table_info('transcript_events') WHERE name = 'event_zstd'").get();
    const rows = database.prepare(`SELECT t.event_json, ${compressed ? "t.event_zstd" : "NULL"} AS event_zstd FROM session_windows w
      JOIN transcript_events t ON t.session_id = w.session_id
      WHERE w.session_key = ? ORDER BY w.created_at, w.session_id, t.seq`).iterate(key);
    function* entries() {
      for (const row of rows) yield JSON.parse(row.event_json ?? zstdDecompressSync(row.event_zstd).toString("utf8"));
    }
    return summarizeTrajectory(entries(), {before});
  });
  if (canonical.found) return canonical.result;
  const sessionId = (await loadSessionEntry(key, {agentsRoot}))?.sessionId;
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
    const usage = summarizeTrajectory(await readFile(candidate.path, "utf8"), {before});
    if (usage) return usage;
  }
}

export function modelPrices(config) {
  const prices = {...FALLBACK_PRICES};
  for (const provider of Object.values(config?.models?.providers ?? {})) {
    for (const model of provider?.models ?? []) if (model?.id && model.cost && Object.values(model.cost).some(v => v > 0)) prices[model.id] = model.cost;
  }
  return prices;
}

export function estimateApiCost(usages = [], prices = FALLBACK_PRICES) {
  let usd = 0, unpriced = false;
  for (const usage of usages) for (const [model, tokens] of Object.entries(usage?.byModel ?? {})) {
    const price = prices[model.replace(/^.*\//, "")];
    if (!price) { unpriced ||= Object.values(tokens).some(Boolean); continue; }
    for (const field of ["input", "output", "cacheRead", "cacheWrite"]) usd += (tokens[field] * (price[field] ?? 0)) / 1e6;
  }
  return {usd, partial: unpriced};
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

export function formatCloseReport({ stats, usage, agent, pullRequests = [], prices }) {
  const records = (Array.isArray(usage) ? usage : [{agent, usage}]).filter(record => record.usage);
  const usages = records.map(record => record.usage);
  const header = ["**Session closed**", stats?.elapsedSeconds != null && duration(stats.elapsedSeconds), stats && `${stats.totalMessages} msgs`].filter(Boolean).join(" · ");
  const lines = [header];
  if (stats?.topic) lines.push(`- What: ${stats.topic}`);
  if (usages.length) {
    const sum = field => usages.reduce((total, value) => total + value[field], 0);
    const fresh = sum("input") + sum("cacheWrite"), read = sum("cacheRead"), cost = estimateApiCost(usages, prices);
    const cached = fresh + read ? ` (${Math.round((100 * read) / (fresh + read))}% cached)` : "";
    lines.push(`- Tokens: ${compact(fresh + read)} in${cached} · ${compact(sum("output"))} out · ${cost.partial ? "≥" : "~"}$${cost.usd.toFixed(2)} API`);
  }
  if (!records.some(record => record.agent === agent)) lines.push(`- Tokens: ${agent ?? "agent"} usage unavailable`);
  if (pullRequests.length) lines.push(`- Code: ${pullRequests.map(pr => [`[PR #${pr.number}](${pr.url})`, pr.state?.toLowerCase(),
    pr.additions != null && `+${pr.additions}/−${pr.deletions}`, pr.changedFiles != null && `${pr.changedFiles} files`].filter(Boolean).join(" · ")).join("; ")}`);
  return lines.join("\n");
}

// Slack posts the report straight through chat.postMessage, which reads mrkdwn, not Markdown.
export function slackMrkdwn(markdown) {
  return String(markdown ?? "").replace(/\*\*(.+?)\*\*/g, "*$1*").replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "<$2|$1>").replace(/^- /gm, "• ");
}

export async function loadSlackThreadSnapshot({channel, threadId, latest, token, call, limit = 20}) {
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

export function closeReportPath(dataRoot, operationId) {
  return join(dataRoot, 'generated', 'sessions', createHash('sha256').update(operationId).digest('hex').slice(0, 24) + '.md');
}

export async function writeCloseReport({dataRoot, operationId, report}) {
  const viewPath = closeReportPath(dataRoot, operationId);
  await mkdir(dirname(viewPath), {recursive: true});
  await writeFile(viewPath, report + '\n', {mode: 0o600});
  return viewPath;
}

export async function recordSessionClose({ dataRoot, channel, thread, agent, summary, stats, usage, operationId, report, now = new Date() }) {
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
  const viewName = createHash("sha256").update(operationId).digest("hex").slice(0, 24);
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
  return { event, viewPath };
}
