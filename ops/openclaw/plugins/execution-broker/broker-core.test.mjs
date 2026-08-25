import test from "node:test";
import assert from "node:assert/strict";
import {extractIntents, renderCoverageContext, resolveExecutionPlan} from "./broker-core.mjs";

const catalog = {
  schemaVersion: 2,
  defaultProfile: "codex-low",
  agents: {
    liv: {defaultProfile: "cursor-low", allowedProfiles: ["cursor-low", "cursor-high", "codex-low"]},
    max: {defaultProfile: "codex-low", allowedProfiles: ["cursor-low", "cursor-high", "codex-low"]},
  },
  profiles: {
    "cursor-low": {executionMode: "general", runtime: "cli", harness: "cursor", family: "cursor-grok", model: "cursor-ask/grok-low", aliases: ["cursor/grok"], reasoning: "low", fastMode: true},
    "cursor-high": {executionMode: "workspace", runtime: "cli", harness: "cursor", family: "cursor-grok", model: "cursor-agent/grok-high", aliases: ["cursor/grok"], reasoning: "high", fastMode: true},
    "codex-low": {executionMode: "workspace", runtime: "app-server", harness: "codex", family: "codex-sol", model: "openai/gpt-5.6-sol", aliases: ["codex/sol"], reasoning: "low", fastMode: true},
  },
};

test("routes an explicit first-turn directive without a model", () => {
  const plan = resolveExecutionPlan({input: "@Liv use Cursor/Grok high, workspace, concise: inspect, fix, and test", catalog, agentId: "liv", channelId: "slack"});
  assert.equal(plan.profileId, "cursor-high");
  assert.equal(plan.task, "inspect, fix, and test");
  assert.deepEqual(plan.style, ["concise"]);
});

test("prefers the general low profile when a family directive is otherwise ambiguous", () => {
  const expanded = structuredClone(catalog);
  expanded.profiles["cursor-agent-low"] = {...expanded.profiles["cursor-low"], executionMode: "workspace", model: "cursor-agent/grok-low"};
  expanded.agents.liv.allowedProfiles.push("cursor-agent-low");
  const plan = resolveExecutionPlan({input: "@Liv use Cursor/Grok low, fast: explain the tradeoff", catalog: expanded, agentId: "liv", channelId: "slack"});
  assert.equal(plan.profileId, "cursor-low");
});

test("uses thread profile before the agent default", () => {
  const plan = resolveExecutionPlan({input: "continue", catalog, agentId: "max", channelId: "slack", persistedProfile: "cursor-low"});
  assert.equal(plan.profileId, "cursor-low");
  assert.equal(plan.source, "thread");
});

test("changes thinking within the persisted harness without a model turn", () => {
  const plan = resolveExecutionPlan({input: "use high thinking: compare both", catalog, agentId: "liv", channelId: "slack", persistedProfile: "cursor-low"});
  assert.equal(plan.profileId, "cursor-high");
  assert.equal(plan.source, "explicit");
});

test("accepts a natural harness switch envelope", () => {
  const plan = resolveExecutionPlan({input: "switch to Codex/Sol low: review this", catalog, agentId: "liv", channelId: "slack", persistedProfile: "cursor-low"});
  assert.equal(plan.profileId, "codex-low");
});

test("fails closed on explicit unsupported routes", () => {
  assert.throws(() => resolveExecutionPlan({input: "use Qwen local: answer", catalog, agentId: "liv", channelId: "slack"}), /unsupported execution directive/);
});

test("requires content after a directive", () => {
  assert.throws(() => resolveExecutionPlan({input: "use Codex/Sol low:", catalog, agentId: "max", channelId: "slack"}), /needs a task/);
});

test("builds a three-item coverage ledger from one sentence", () => {
  const intents = extractIntents("Explain exec; compare app-server, and also recommend a default?");
  assert.equal(intents.length, 3);
  const context = renderCoverageContext({...resolveExecutionPlan({input: "hello", catalog, agentId: "liv", channelId: "slack"}), intents});
  assert.match(context, /3\. recommend a default/);
});

test("does not collapse comma-separated action clauses", () => {
  assert.deepEqual(
    extractIntents("inspect the config, explain the drift, recommend the fix").map((item) => item.text),
    ["inspect the config", "explain the drift", "recommend the fix"],
  );
});

test("recognizes conversational follow-on asks", () => {
  assert.equal(extractIntents("Explain the root and can you compare the tradeoffs and I want a recommendation").length, 3);
});
