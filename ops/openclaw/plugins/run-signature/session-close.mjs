import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { zstdDecompressSync } from "node:zlib";
import { dirname, join } from "node:path";
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

export function summarizeTrajectory(source = "", {before = Infinity} = {}) {
  const totals = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, peakContext: 0 };
  const coverage = {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, peakContext: 0};
  const models = new Map();
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
  }
  if (!totals.turns) return;
  return {
    ...totals, coverage,
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

export function formatCloseReport({ summary = "Recap evidence is limited", outcomes = [], followUps = [], stats, usage, agent, boundary, ownerLabel = "humans" }) {
  const metric = value => value == null ? "unavailable" : typeof value === 'number' ? value.toLocaleString('en-US') : value;
  const lines = ["## Session Closed", `- Summary: ${summary}`, ...outcomes.map(value => `- Recorded outcome: ${value}`),
    `- Unresolved follow-ups: ${followUps.length ? followUps.join('; ') : 'unavailable — no complete follow-up ledger recorded'}`,
    `- Evidence boundary: ${boundary ?? 'recorded thread messages; close report excluded'}`,
    `- Elapsed: ${metric(stats?.elapsed)}`,
    `- Messages: ${metric(stats?.humanMessages)} from ${ownerLabel} / ${metric(stats?.agentMessages)} from agents`,
    `- Words: ${metric(stats?.humanWords)} from ${ownerLabel} / ${metric(stats?.agentWords)} from agents`];
  const usages = Array.isArray(usage) ? usage : [{agent, usage}];
  for (const record of usages) {
    const value = record.usage;
    lines.push(`- Runtime: ${record.agent ?? 'agent'} · ${value?.models ?? 'models unavailable'} · ${value ? value.turns + ' recorded model turns (partial thread coverage)' : 'usage unavailable'}`);
    for (const [field, label] of Object.entries({input: 'Fresh input', cacheRead: 'Cache read', cacheWrite: 'Cache write', output: 'Tokens out', peakContext: 'Context peak'})) {
      const count = value?.coverage?.[field];
      lines.push(`- ${label}: ${count ? metric(value[field]) + ' tokens' + (count < value.turns ? ` (partial: ${count}/${value.turns} recorded turns)` : '') : 'unavailable'}`);
    }
  }
  return lines.join('\n');
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

export function reportParts(report, limit = 3000) {
  const parts = [];
  let rest = report;
  while (rest.length > limit) {
    let end = rest.lastIndexOf('\n', limit);
    if (end < 1) end = limit;
    if (/^[\uDC00-\uDFFF]$/.test(rest[end])) end--;
    parts.push(rest.slice(0, end)); rest = rest.slice(end);
  }
  if (rest) parts.push(rest);
  return parts;
}

export async function recordSessionClose({ dataRoot, channel, thread, agent, summary, stats, usage, ownerLabel, operationId, report, now = new Date() }) {
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
