#!/usr/bin/env node

import {readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";
import {extractAgentResult} from "../../ops/channels/campfire/bridge.mjs";
import {normalizeOutboundStatus} from "../../ops/openclaw/plugins/run-signature/strip-core.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(root, "cases.json"), "utf8"));
const lifecycle = /^## (?:❓ Clarify|✋ Act|🗓️ Scheduled|Session Closed)\s*$/gm;
const forbidden = /(?:^|\n)(?:## Status|Goal:|Agent — working)|No action needed\./m;

export function gradeEnvelope(text, expect) {
  const response = String(text ?? "").trim();
  const failures = [];
  const lifecycleHeadings = [...response.matchAll(lifecycle)];
  const h2 = [...response.matchAll(/^## .+$/gm)];
  if (!response) failures.push("missing final response");
  if (forbidden.test(response)) failures.push("retired protocol prose is visible");
  if (lifecycleHeadings.length > 1) failures.push("more than one lifecycle section");
  if (lifecycleHeadings.length && lifecycleHeadings[0].index !== h2.at(-1)?.index) failures.push("lifecycle section is not last");
  if (expect.shape === "short" && h2.length) failures.push("short answer has headings");
  if (expect.shape === "substantive" && !response.startsWith("## TLDR\n")) failures.push("substantive answer does not start with TLDR");
  if (normalizeOutboundStatus(response).status !== expect.status) failures.push(`expected status ${expect.status}`);
  if (expect.mustMatch && !new RegExp(expect.mustMatch, "i").test(response)) failures.push("required evidence is absent");
  return {pass: failures.length === 0, failures};
}

function readOption(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!process.argv.includes("--live")) {
    console.error("Usage: node evals/slack-response-envelope/eval.mjs --live [--agent liv|max|all] [--binary /absolute/openclaw]");
    process.exit(2);
  }
  const selected = readOption("--agent", "all");
  const agents = selected === "all" ? ["liv", "max"] : [selected];
  const binary = readOption("--binary", process.env.OPENCLAW_BIN || "/opt/homebrew/bin/openclaw");
  const results = [];
  for (const agent of agents) {
    for (const entry of cases) {
      const run = spawnSync(binary, ["agent", "--agent", agent, "--session-key", `agent:${agent}:eval:response-envelope:${entry.id}:${Date.now()}`, "--message", entry.prompt, "--thinking", "low", "--timeout", "180", "--json"], {encoding: "utf8", timeout: 190_000});
      if (run.status !== 0) {
        results.push({agent, caseId: entry.id, pass: false, failures: [run.stderr.trim() || `OpenClaw exited ${run.status}`]});
        continue;
      }
      try {
        const output = extractAgentResult(JSON.parse(run.stdout));
        results.push({agent, caseId: entry.id, ...gradeEnvelope(output.text, entry.expect), provenance: output.provenance});
      } catch (error) {
        results.push({agent, caseId: entry.id, pass: false, failures: [error.message]});
      }
    }
  }
  console.log(JSON.stringify({schemaVersion: 1, results}, null, 2));
  if (results.some((result) => !result.pass)) process.exitCode = 1;
}
