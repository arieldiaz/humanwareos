#!/usr/bin/env node
// ask-history: goal → Jev-filtered context pack over the local history index. See docs/history-retrieval.md.
import {homedir} from "node:os";
import {join} from "node:path";
import {parseArgs} from "node:util";
import {scoreWithJev} from "./jev.mjs";
import {buildPack, PACK_SIZE, summarize} from "./pack.mjs";
import {EGRESS_MODES} from "./privacy.mjs";
import {readAgentSessions, readMemoryEvents, readPullRequests} from "./sources.mjs";
import {DEFAULT_URI, openStore} from "./store.mjs";

const USAGE = `usage:
  ask-history "<goal>"              Jev-filtered pack
  ask-history --search "<goal>"     search-only top ${PACK_SIZE}; nothing leaves the host
  ask-history --compare "<goal>"    both, with provider usage
  ask-history --show <id>           one local document
  ask-history --ingest [--days 14] [--agents liv,max] [--pr-repo owner/name]
options: --egress metadata|full (default metadata; full sends bounded conversation excerpts), --text, --candidates 200`;

const {values, positionals} = parseArgs({allowPositionals: true, options: {
  search: {type: "boolean"}, compare: {type: "boolean"}, show: {type: "string"}, ingest: {type: "boolean"},
  days: {type: "string", default: "14"}, agents: {type: "string", default: "liv,max"}, "pr-repo": {type: "string"},
  egress: {type: "string", default: "metadata"}, candidates: {type: "string", default: "200"}, text: {type: "boolean"}, help: {type: "boolean"},
}});

async function ingest(store) {
  const sinceMs = Date.now() - Number(values.days) * 86400000;
  const dataRoot = process.env.HUMANWARE_DATA_ROOT;
  if (!dataRoot) throw new Error("HUMANWARE_DATA_ROOT is required for ingest");
  const stateDir = process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw");
  const counts = {};
  for (const agent of values.agents.split(",").filter(Boolean)) counts[`sessions:${agent}`] = await store.upsert(readAgentSessions({stateDir, agent, sinceMs}));
  counts.decisions = await store.upsert(readMemoryEvents({dataRoot, sinceDay: new Date(sinceMs).toISOString().slice(0, 10)}));
  if (values["pr-repo"]) counts.prs = await store.upsert(readPullRequests({repo: values["pr-repo"]}));
  return {ingested: counts, total: await store.count()};
}

async function ask(store, goal) {
  const limit = Math.min(Math.max(Number(values.candidates) || 200, 1), 200);
  const candidates = await store.search(goal, limit);
  const searchOnly = candidates.slice(0, PACK_SIZE).map((doc, rank) => ({...summarize(doc), searchRank: rank + 1}));
  if (values.search) return {goal, candidates: candidates.length, searchOnly};
  const {scores, usage} = await scoreWithJev({goal, docs: candidates, mode: values.egress, apiKey: process.env.OPENROUTER_API_KEY});
  const pack = buildPack({candidates, scores});
  const unscored = [...scores.values()].filter((score) => score.status !== "scored").length;
  return {goal, egress: values.egress, candidates: candidates.length, unscored, usage, ...pack, ...(values.compare ? {searchOnly} : {})};
}

function render(result) {
  if (!result.goal) return JSON.stringify(result, null, 2);
  const line = (item) => `  ${String(item.searchRank).padStart(3)}  ${item.p == null ? (item.status ?? "") : item.p.toFixed(2)}  ${item.kind.padEnd(8)} ${item.date ?? ""}  ${item.title}`;
  const out = [`goal: ${result.goal}`, `candidates: ${result.candidates}`];
  if (result.searchOnly) out.push("search-only top:", ...result.searchOnly.map(line));
  if (result.kept) {
    out.push(`jev-filtered pack (egress ${result.egress}, ${result.unscored} unscored):`, ...result.kept.map(line), `dropped ids: ${result.dropped.length}`);
    const u = result.usage;
    out.push(`usage: ${u.requests} requests, ${u.inputTokens} in / ${u.outputTokens} out tokens, $${u.cost.toFixed(6)}${u.unknownUsageRequests ? `, ${u.unknownUsageRequests} with unknown usage` : ""}`);
  }
  return out.join("\n");
}

async function main() {
  if (values.help) return console.log(USAGE);
  if (!EGRESS_MODES.includes(values.egress)) throw new Error(`--egress must be one of ${EGRESS_MODES.join(", ")}`);
  const goal = positionals.join(" ").trim();
  if (!values.ingest && !values.show && !goal) return console.error(USAGE), (process.exitCode = 2);
  const store = await openStore(process.env.HISTORY_MONGODB_URI ?? DEFAULT_URI);
  try {
    const result = values.ingest ? await ingest(store) : values.show ? (await store.show(values.show)) ?? {error: "not found"} : await ask(store, goal);
    console.log(values.text ? render(result) : JSON.stringify(result, null, 2));
  } finally {
    await store.close();
  }
}

main().catch((error) => {
  console.error(`ask-history: ${error.message}`);
  process.exitCode = 1;
});
