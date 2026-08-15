import fs from "node:fs";
import path from "node:path";

const dist = "/opt/homebrew/lib/node_modules/openclaw/dist";
const files = fs.readdirSync(dist);
const attempt = files.find((name) => /^attempt\.model-diagnostic-events-.*\.js$/.test(name));
const selection = files.find((name) => {
  if (!/^selection-.*\.js$/.test(name)) return false;
  return fs.readFileSync(path.join(dist, name), "utf8").includes("transport: effectiveAgentTransport,");
});
// Some chunk names exist twice: a real bundle plus a tiny re-export shim.
// Select by content, never by name alone.
const findByContent = (pattern, needle) => files.find((name) => {
  if (!pattern.test(name)) return false;
  return fs.readFileSync(path.join(dist, name), "utf8").includes(needle);
});
const lifecycle = findByContent(/^lifecycle-hook-helpers-.*\.js$/, "...params.modelId ? { modelId: params.modelId } : {},");
const cliRunner = findByContent(/^cli-runner-.*\.js$/, "runAgentHarnessLlmOutputHook");
const runAttempt = findByContent(/^run-attempt-.*\.js$/, "channelId: hookChannelId,");
if (!attempt || !selection || !lifecycle || !cliRunner || !runAttempt) throw new Error("OpenClaw model-call bundles not found.");

function patch(name, replacements) {
  const target = path.join(dist, name);
  let source = fs.readFileSync(target, "utf8");
  if (source.includes("thinkingProvenancePatched: true")) return "alreadyPatched";
  for (const [from, to] of replacements) {
    if (!source.includes(from)) throw new Error(`OpenClaw bundle shape changed in ${name}.`);
    source = source.replace(from, to);
  }
  source += "\n//# thinkingProvenancePatched: true\n";
  fs.writeFileSync(target, source);
  return "patched";
}

const attemptStatus = patch(attempt, [
  ["\t\t...ctx.transport && { transport: ctx.transport },", "\t\t...ctx.transport && { transport: ctx.transport },\n\t\t...ctx.thinkLevel && { thinkLevel: ctx.thinkLevel },"],
  ["\t\t...eventBase.transport ? { transport: eventBase.transport } : {},", "\t\t...eventBase.transport ? { transport: eventBase.transport } : {},\n\t\t...eventBase.thinkLevel ? { thinkLevel: eventBase.thinkLevel } : {},"],
]);

const selectionStatus = patch(selection, [[
  "\t\t\t\ttransport: effectiveAgentTransport,",
  "\t\t\t\ttransport: effectiveAgentTransport,\n\t\t\t\tthinkLevel: params.thinkLevel,",
]]);

// The three patches above only cover the embedded runtime. CLI-harness runs
// (claude-cli, codex app-server) never pass through that streamFn wrapper:
// their only provenance-bearing hooks are llm_input/llm_output, whose shared
// hook context omits the run's resolved thinkLevel even though it is in scope
// (cli-runner sends it to the CLI as `thinking:`, run-attempt derives the
// codex `effort` from it). Add it to both builders and let it through the
// buildAgentHookContext whitelist that wraps every harness hook ctx.
const lifecycleStatus = patch(lifecycle, [[
  "\t\t...params.modelId ? { modelId: params.modelId } : {},",
  "\t\t...params.modelId ? { modelId: params.modelId } : {},\n\t\t...params.thinkLevel ? { thinkLevel: params.thinkLevel } : {},",
]]);

const cliRunnerStatus = patch(cliRunner, [[
  "\t\t...params.config ? { config: params.config } : {},",
  "\t\t...params.config ? { config: params.config } : {},\n\t\t...params.thinkLevel ? { thinkLevel: params.thinkLevel } : {},",
]]);

const runAttemptStatus = patch(runAttempt, [[
  "\t\tchannelId: hookChannelId,\n\t\t...hookContextWindowFields",
  "\t\tchannelId: hookChannelId,\n\t\t...params.thinkLevel ? { thinkLevel: params.thinkLevel } : {},\n\t\t...hookContextWindowFields",
]]);

console.log(JSON.stringify({ attempt: attemptStatus, selection: selectionStatus, lifecycle: lifecycleStatus, cliRunner: cliRunnerStatus, runAttempt: runAttemptStatus }));
