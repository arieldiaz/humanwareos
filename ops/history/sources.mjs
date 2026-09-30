import {execFileSync} from "node:child_process";
import {readdirSync, readFileSync, existsSync} from "node:fs";
import {join} from "node:path";
import {DatabaseSync} from "node:sqlite";

const LOCAL_TEXT_CHARS = 60000;
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const counted = (counts) => [...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name}×${n}`);

function parse(json) {
  try { return typeof json === "string" ? JSON.parse(json) : json ?? {}; } catch { return {}; }
}

function touchedFiles(args) {
  const files = [];
  for (const key of ["path", "file_path", "filePath"]) if (typeof args[key] === "string") files.push(args[key]);
  if (Array.isArray(args.paths)) files.push(...args.paths.filter((path) => typeof path === "string"));
  for (const patch of [args.patch, args.input]) if (typeof patch === "string") for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) files.push(match[1].trim());
  return files;
}

/** One document per harness session window with transcript activity since `sinceMs`. Read-only. */
export function readAgentSessions({stateDir, agent, sinceMs}) {
  const path = join(stateDir, "agents", agent, "agent", "openclaw-agent.sqlite");
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, {readOnly: true});
  try {
    const windows = db.prepare(`SELECT w.session_id, w.session_key, w.created_at, w.display_name, n.label
      FROM session_windows w LEFT JOIN session_nodes n ON n.session_key = w.session_key
      WHERE EXISTS (SELECT 1 FROM transcript_events e WHERE e.session_id = w.session_id AND e.created_at >= ?)`).all(sinceMs);
    const events = db.prepare("SELECT event_json, created_at FROM transcript_events WHERE session_id = ? ORDER BY seq");
    return windows.map((window) => {
      const tools = new Map(), files = new Set(), text = [];
      let last = window.created_at;
      for (const row of events.iterate(window.session_id)) {
        last = Math.max(last, row.created_at);
        const message = parse(row.event_json).message;
        if (!Array.isArray(message?.content)) {
          if (typeof message?.content === "string" && message.role === "user") text.push(message.content);
          continue;
        }
        for (const part of message.content) {
          if (part?.type === "toolCall" && typeof part.name === "string") {
            tools.set(part.name, (tools.get(part.name) ?? 0) + 1);
            touchedFiles(parse(part.arguments)).forEach((file) => files.add(file));
          } else if (part?.type === "text" && (message.role === "user" || message.role === "assistant")) text.push(part.text);
        }
      }
      const [, , surface = "session"] = window.session_key.split(":");
      const channel = window.display_name?.match(/#[\w-]+/)?.[0];
      return {
        _id: `session:${agent}:${window.session_id}`,
        kind: "session",
        agent,
        ts: new Date(last),
        title: window.label || window.display_name || `${agent} ${surface} session`,
        meta: {agent, surface: /^[a-z-]+$/.test(surface) ? surface : "session", channel, date: day(window.created_at), label: window.label || undefined, tools: counted(tools), files: [...files].slice(0, 40)},
        localText: text.join("\n").slice(0, LOCAL_TEXT_CHARS),
        sourceRef: {store: "openclaw-agent-sqlite", agent, sessionId: window.session_id},
      };
    });
  } finally {
    db.close();
  }
}

const SUMMARY_KEYS = ["summary", "decision", "subject", "result", "event", "state", "blocker", "remaining"];

function oneLine(event) {
  const parts = [];
  for (const key of SUMMARY_KEYS) {
    const value = event[key];
    if (typeof value === "string") parts.push(value);
    else if (value && typeof value === "object" && typeof value.summary === "string") parts.push(value.summary);
  }
  if (!parts.length && Array.isArray(event.facts)) parts.push(...event.facts.filter((fact) => typeof fact === "string").slice(0, 2));
  return parts.join(" — ").replace(/\s+/g, " ").slice(0, 300);
}

/** Curated memory events dated on or after `sinceDay` (YYYY-MM-DD filename prefix). */
export function readMemoryEvents({dataRoot, sinceDay}) {
  const dir = join(dataRoot, "evidence", "memory", "events");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}-.+\.json$/.test(name) && name.slice(0, 10) >= sinceDay).map((name) => {
    const raw = readFileSync(join(dir, name), "utf8");
    const event = parse(raw);
    const date = name.slice(0, 10), slug = name.slice(11, -5);
    return {
      _id: `decision:${slug}:${date}`,
      kind: "decision",
      ts: new Date(`${date}T12:00:00Z`),
      title: slug.replace(/-/g, " "),
      meta: {date, summary: oneLine(event) || slug.replace(/-/g, " ")},
      localText: raw.slice(0, LOCAL_TEXT_CHARS),
      sourceRef: {store: "memory-events", file: name},
    };
  });
}

/** Pull requests through the GitHub CLI. Titles and descriptions are egress-eligible metadata. */
export function readPullRequests({repo, limit = 300, gh = "gh"}) {
  const json = execFileSync(gh, ["pr", "list", "--repo", repo, "--state", "all", "--limit", String(limit), "--json", "number,title,body,state,createdAt,mergedAt,files,url"], {encoding: "utf8", maxBuffer: 64 * 1024 * 1024});
  return JSON.parse(json).map((pr) => ({
    _id: `pr:${repo}#${pr.number}`,
    kind: "pr",
    ts: new Date(pr.mergedAt ?? pr.createdAt),
    title: `#${pr.number} ${pr.title}`,
    meta: {number: pr.number, title: pr.title, description: pr.body ?? "", state: pr.state, created: pr.createdAt?.slice(0, 10), merged: pr.mergedAt?.slice(0, 10), files: (pr.files ?? []).map((file) => file.path)},
    localText: "",
    sourceRef: {store: "github", repo, url: pr.url},
  }));
}
