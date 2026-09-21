#!/usr/bin/env node

import {closeSync, openSync, readFileSync, unlinkSync, writeFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";
import {extractAgentResult} from "../../ops/channels/campfire/bridge.mjs";
import {normalizeOutboundStatus} from "../../ops/openclaw/plugins/run-signature/strip-core.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(root, "cases.json"), "utf8"));
const lifecycle = /^## (?:✋ Act|🗓️ Scheduled|Session Closed)\s*$/gm;
const forbidden = /(?:^|\n)(?:## Status|## ❓ Clarify|Goal:|Agent — working)|No action needed\./m;
const sleepState = new Int32Array(new SharedArrayBuffer(4));

export function gradeEnvelope(text, expect) {
  const response = String(text ?? "").trim();
  const failures = [];
  const lifecycleHeadings = [...response.matchAll(lifecycle)];
  const h2 = [...response.matchAll(/^## .+$/gm)];
  const lifecycleIndexes = new Set(lifecycleHeadings.map((heading) => heading.index));
  const nonLifecycleHeadings = h2.filter((heading) => !lifecycleIndexes.has(heading.index));
  if (!response) failures.push("missing final response");
  if (forbidden.test(response)) failures.push("retired protocol prose is visible");
  if (lifecycleHeadings.length > 1) failures.push("more than one lifecycle section");
  if (lifecycleHeadings.length && lifecycleHeadings[0].index !== h2.at(-1)?.index) failures.push("lifecycle section is not last");
  if (expect.shape === "short" && nonLifecycleHeadings.length) failures.push("short answer has non-lifecycle headings");
  if (expect.shape === "substantive" && !response.startsWith("## TLDR\n")) failures.push("substantive answer does not start with TLDR");
  if (normalizeOutboundStatus(response).status !== expect.status) failures.push(`expected status ${expect.status}`);
  if (expect.mustMatch && !new RegExp(expect.mustMatch, "i").test(response)) failures.push("required evidence is absent");
  return {pass: failures.length === 0, failures};
}

function readOption(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

export function parseGatewayHealth(stdout) {
  try {
    const health = JSON.parse(String(stdout ?? ""));
    return {
      ready: health?.ok === true && health?.eventLoop?.degraded !== true,
      reason: health?.eventLoop?.degraded === true ? `gateway event loop degraded: ${health.eventLoop.reasons?.join(", ") || "unknown"}` : health?.ok === true ? "ready" : "gateway health is not ok"
    };
  } catch {
    return {ready: false, reason: "gateway health response is not valid JSON"};
  }
}

function sleep(ms) {
  Atomics.wait(sleepState, 0, 0, ms);
}

function waitForGateway(binary) {
  let reason = "gateway readiness probe did not run";
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const probe = spawnSync(binary, ["gateway", "call", "health", "--json", "--timeout", "3000"], {encoding: "utf8", timeout: 5_000});
    if (probe.status === 0) {
      const health = parseGatewayHealth(probe.stdout);
      if (health.ready) return {ready: true, attempts: attempt};
      reason = health.reason;
    } else {
      reason = probe.stderr.trim() || `gateway probe exited ${probe.status}`;
    }
    if (attempt < 6) sleep(5_000);
  }
  return {ready: false, reason};
}

export function acquireLock(path) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, `${process.pid}\n`);
      closeSync(fd);
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        try { unlinkSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = Number.parseInt(readFileSync(path, "utf8"), 10);
      let alive = Number.isInteger(owner) && owner > 0;
      if (alive) {
        try { process.kill(owner, 0); } catch (probeError) { if (probeError.code === "ESRCH") alive = false; else throw probeError; }
      }
      if (alive) throw new Error(`response-envelope eval already running as pid ${owner}`);
      unlinkSync(path);
    }
  }
  throw new Error("could not acquire response-envelope eval lock");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!process.argv.includes("--live")) {
    console.error("Usage: node evals/slack-response-envelope/eval.mjs --live [--agent liv|max|all] [--case CASE_ID] [--binary /absolute/openclaw]");
    process.exit(2);
  }
  const selected = readOption("--agent", "all");
  const agents = selected === "all" ? ["liv", "max"] : [selected];
  const selectedCase = readOption("--case", "all");
  const selectedCases = selectedCase === "all" ? cases : cases.filter((entry) => entry.id === selectedCase);
  const binary = readOption("--binary", process.env.OPENCLAW_BIN || "/opt/homebrew/bin/openclaw");
  if (!agents.every((agent) => ["liv", "max"].includes(agent)) || selectedCases.length === 0) {
    console.error("Unknown agent or case selection");
    process.exit(2);
  }
  const releaseLock = acquireLock(process.env.HUMANWARE_RESPONSE_ENVELOPE_EVAL_LOCK || "/tmp/humanware-response-envelope-eval.lock");
  process.on("exit", releaseLock);
  process.on("SIGINT", () => process.exit(130));
  process.on("SIGTERM", () => process.exit(143));
  const results = [];
  for (const agent of agents) {
    for (const entry of selectedCases) {
      const readiness = waitForGateway(binary);
      if (!readiness.ready) {
        results.push({agent, caseId: entry.id, pass: false, durationMs: 0, failures: [readiness.reason]});
        continue;
      }
      const startedAt = Date.now();
      const run = spawnSync(binary, ["agent", "--agent", agent, "--session-key", `agent:${agent}:eval:response-envelope:${entry.id}:${Date.now()}`, "--message", entry.prompt, "--thinking", "low", "--timeout", "180", "--json"], {encoding: "utf8", timeout: 190_000});
      const durationMs = Date.now() - startedAt;
      if (run.status !== 0) {
        results.push({agent, caseId: entry.id, pass: false, durationMs, failures: [run.stderr.trim() || `OpenClaw exited ${run.status}`]});
        continue;
      }
      try {
        const raw = JSON.parse(run.stdout);
        if (raw?.ok === false) throw new Error(raw.error?.message || "OpenClaw returned ok=false");
        const output = extractAgentResult(raw);
        results.push({agent, caseId: entry.id, durationMs, ...gradeEnvelope(output.text, entry.expect), text: output.text, provenance: output.provenance});
      } catch (error) {
        results.push({agent, caseId: entry.id, pass: false, durationMs, failures: [error.message]});
      }
    }
  }
  console.log(JSON.stringify({schemaVersion: 1, results}, null, 2));
  if (results.some((result) => !result.pass)) process.exitCode = 1;
}
