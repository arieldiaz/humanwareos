import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  addReactionsInOrder,
  slackApi,
  buildRunReactionNames,
  ADMITTED_STATUS,
  createKeyedSerialQueue,
  planStatusTile,
  resolveHarnessTile,
  resolveModelTile,
  resolveStatusTile,
  resolveBotUserId,
  resolveConfiguredThinking,
  slackRouteFromSessionKey,
  resolveSlackChannelId,
  resolveDataRoot,
  normalizeThinkingLevel,
  resolveThinkingTile,
  retrySlackRateLimit,
  resolveSlackRuntimeModule,
  mergeProvenance,
  resolveSelectedHarness,
  normalizeReactions,
} from "./index.js";
import runSignaturePlugin from "./index.js";

test("registers transport hooks without semantic collaboration hooks", () => {
  const hooks = [];
  runSignaturePlugin.register({
    config: {},
    on(name) {
      hooks.push(name);
    },
  });
  assert.equal(hooks.includes("before_dispatch"), false);
  assert.equal(hooks.includes("inbound_claim"), true);
  assert.equal(hooks.includes("before_prompt_build"), false);
  assert.equal(hooks.includes("before_tool_call"), true);
  assert.equal(hooks.includes("reply_payload_sending"), false);
  assert.ok(hooks.includes("llm_input"));
  assert.ok(hooks.includes("model_call_started"));
  assert.ok(hooks.includes("agent_end"));
  assert.ok(hooks.includes("message_sent"));
});

test("registers one atomic Slack work-thread tool with the normal high-reasoning path", () => {
  const tools = [];
  runSignaturePlugin.register({
    config: {},
    on() {},
    registerTool(factory, options) {
      tools.push({ factory, options });
    },
  });
  assert.deepEqual(tools.map(tool => tool.options.name), ["start_work_thread", "close_thread", "switch_model"]);
  const manifest = JSON.parse(readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.contracts.tools, tools.map(tool => tool.options.name));
  assert.equal(tools[0].factory.contextVersion, 2);
  assert.equal(tools[0].factory.create({ messageChannel: "discord", agentId: "max" }), undefined);
  const tool = tools[0].factory.create({
    messageChannel: "slack",
    nativeChannelId: "C123",
    agentId: "max",
    agentAccountId: "max",
  });
  assert.equal(tool.name, "start_work_thread");
  assert.deepEqual(tool.parameters.required, ["title", "detail"]);
  assert.ok(tool.parameters.properties.channel);
  assert.match(tool.description, /durable high-reasoning session/);
});

test("exposes start_work_thread to claude-cli loopback sessions that lack nativeChannelId", () => {
  const tools = [];
  runSignaturePlugin.register({ config: {}, on() {}, registerTool(factory, options) { tools.push({ factory, options }); } });
  const sessionKey = "agent:liv:slack:channel:c0br94zuu9y:thread:1791466852.431599";
  // Shape built by OpenClaw 2026.9.8 tool-resolution for the loopback surface: agentId from the session key, no nativeChannelId or sender.
  const fromSessionKey = tools[0].factory.create({ messageChannel: "slack", agentId: "liv", sessionKey });
  assert.equal(fromSessionKey?.name, "start_work_thread");
  const fromDelivery = tools[0].factory.create({ messageChannel: "slack", agentId: "liv", agentAccountId: "liv", sessionKey: "agent:liv:main", deliveryContext: { channel: "slack", to: "channel:C0BR94ZUU9Y" } });
  assert.equal(fromDelivery?.name, "start_work_thread");
  assert.equal(tools[0].factory.create({ messageChannel: "slack", agentId: "liv", sessionKey: "agent:liv:main" }), undefined);
});

// --- tiles ---

test("maps the configured model and harness tiles", () => {
  assert.equal(resolveModelTile("claude-cli/claude-opus-5"), ":m_opus:");
  assert.equal(resolveModelTile("claude-fable-5"), ":m_fable:");
  assert.equal(resolveModelTile("openai/gpt-5.6-sol"), ":m_gpt_sol:");
  assert.equal(resolveModelTile("ollama/qwen3:32b"), ":m_qwen_dense:");
  assert.equal(resolveModelTile("qwen3:30b-a3b"), ":m_qwen_moe:");
  assert.equal(resolveModelTile("ollama/llama3.3:70b"), ":m_llama:");
  assert.equal(resolveModelTile("cursor/auto"), ":m_cursor_auto:");
  assert.equal(resolveModelTile("cursor/cursor-grok-4.6-high"), ":m_grok:");
  assert.equal(resolveModelTile("cursor-agent/grok-4.7-low-fast"), ":m_grok:");
  assert.equal(resolveModelTile("mystery"), undefined);
  assert.equal(resolveHarnessTile("codex"), ":h_codex:");
  assert.equal(resolveHarnessTile("claude-cli"), ":h_cc:");
  assert.equal(resolveHarnessTile("cursor-agent"), ":h_cursor:");
  assert.equal(resolveHarnessTile("cursor"), ":h_cursor:");
  assert.equal(resolveHarnessTile("opencode"), ":h_opencode:");
  // Exact ids only: provider names, model refs and session keys are not harnesses.
  assert.equal(resolveHarnessTile("anthropic"), undefined);
  assert.equal(resolveHarnessTile("agent:max:opencode:x"), undefined);
  assert.equal(resolveHarnessTile("toString"), undefined);
  assert.equal(resolveHarnessTile(undefined), undefined);
});

test("normalizes provider thinking vocabularies without guessing", () => {
  assert.equal(normalizeThinkingLevel("off"), "off");
  assert.equal(normalizeThinkingLevel("none"), "off");
  assert.equal(normalizeThinkingLevel("minimal"), "low");
  assert.equal(normalizeThinkingLevel("medium"), "medium");
  assert.equal(normalizeThinkingLevel("high"), "high");
  assert.equal(normalizeThinkingLevel("xhigh"), "max");
  assert.equal(normalizeThinkingLevel("adaptive"), "auto");
  assert.equal(normalizeThinkingLevel("banana"), undefined);
  assert.equal(normalizeThinkingLevel(undefined), undefined);
});

test("uses the resolved think level for the tile and omits when unknown", () => {
  assert.equal(resolveThinkingTile({ thinkLevel: "high" }), ":think_high:");
  assert.equal(resolveThinkingTile({ reasoningEffort: "xhigh" }), ":think_max:");
  assert.equal(resolveThinkingTile({}), undefined);
});

test("builds the compact model harness signature", () => {
  const provenance = { model: "claude-opus-5", provider: "anthropic", harnessId: "claude-cli", thinkLevel: "off" };
  assert.deepEqual(buildRunReactionNames(provenance), ["m_opus", "h_cc", "think_off"]);
  // A provider name is not a harness id.
  assert.deepEqual(buildRunReactionNames({ model: "claude-opus-5", provider: "claude-cli", thinkLevel: "off" }), ["m_opus", "think_off"]);
});

test("native-local reaction signatures omit harness and unknown thinking", () => {
  assert.deepEqual(
    buildRunReactionNames({ model: "ollama/llama3.3:70b", provider: "ollama" }),
    ["m_llama"],
  );
});

test("lays per-message reactions sequentially in canonical order", async () => {
  const observed = [];
  await addReactionsInOrder(["m_gpt_sol", "h_codex", "think_high"], async (name) => {
    await Promise.resolve();
    observed.push(name);
  });
  assert.deepEqual(observed, ["m_gpt_sol", "h_codex", "think_high"]);
});

// --- the status-tile planner ---

const SPEC = { sendingBotId: "ULIV", botUserIds: new Set(["ULIV", "UMAX"]) };
const ownTile = (name) => ({ name, users: ["ULIV"] });
const addNames = (plan) => plan.add.map((item) => item.name);
const removeNames = (plan) => plan.remove.map((item) => item.name);

test("first send lays exactly one tile: the lifecycle status", () => {
  const plan = planStatusTile([], { ...SPEC, lifecycle: "raised_hand" });
  assert.deepEqual(addNames(plan), ["raised_hand"]);
  assert.deepEqual(plan.remove, []);
});

test("an admitted turn deterministically lays the working tile", () => {
  assert.equal(ADMITTED_STATUS, "working");
  const lifecycle = resolveStatusTile(ADMITTED_STATUS, [], SPEC.botUserIds);
  assert.deepEqual(addNames(planStatusTile([], { ...SPEC, lifecycle })), ["arrows_counterclockwise"]);
});

test("a correct status tile is a strict no-op", () => {
  const plan = planStatusTile([ownTile("raised_hand")], { ...SPEC, lifecycle: "raised_hand" });
  assert.equal(plan.unchanged, true);
  assert.deepEqual(plan.add, []);
  assert.deepEqual(plan.remove, []);
});

test("a lifecycle transition swaps the one tile", () => {
  const plan = planStatusTile([ownTile("arrows_counterclockwise")], { ...SPEC, lifecycle: "raised_hand" });
  assert.deepEqual(removeNames(plan), ["arrows_counterclockwise"]);
  assert.deepEqual(addNames(plan), ["raised_hand"]);
});

test("a run ending on a closed thread keeps ✅: ✋ never replaces a bot-held ✅, 🔄 does", () => {
  const closed = [ownTile("white_check_mark")];
  const act = planStatusTile(closed, { ...SPEC, lifecycle: "raised_hand" });
  assert.equal(act.unchanged, true);
  assert.equal(act.effective, "white_check_mark");
  const working = planStatusTile(closed, { ...SPEC, lifecycle: "arrows_counterclockwise" });
  assert.deepEqual(working.remove.map(r => r.name), ["white_check_mark"]);
  assert.equal(working.effective, "arrows_counterclockwise");
});

test("done replaces a stale working tile", () => {
  const plan = planStatusTile([ownTile("arrows_counterclockwise")], { ...SPEC, lifecycle: "white_check_mark" });
  assert.deepEqual(removeNames(plan), ["arrows_counterclockwise"]);
  assert.deepEqual(addNames(plan), ["white_check_mark"]);
});

test("human reactions neither override nor suppress the bot projection", () => {
  const observed = [{name: "white_check_mark", users: ["UHUMAN"]}, {name: "calendar", users: ["UMAX"]}];
  const plan = planStatusTile(observed, {...SPEC, lifecycle: "raised_hand"});
  assert.deepEqual(plan.remove, [{name: "calendar", holders: ["UMAX"]}]);
  assert.deepEqual(addNames(plan), ["raised_hand"]);
  assert.equal(resolveStatusTile("act", observed, SPEC.botUserIds), "raised_hand");
});

test("steady-state projection leaves noncanonical and human reactions untouched", () => {
  const plan = planStatusTile([{name: "m_fable", users: ["ULIV"]}, {name: "question", users: ["ULIV"]}], {...SPEC, lifecycle: "raised_hand"});
  assert.deepEqual(plan.remove, []);
});

test("a human-held provenance tile is never touched", () => {
  const observed = [
    { name: "butterfly", users: ["UHUMAN"] },
    { name: "raised_hand", users: ["ULIV"] },
  ];
  const plan = planStatusTile(observed, { ...SPEC, lifecycle: "raised_hand" });
  assert.equal(plan.unchanged, true);
});

test("reactions outside the strip vocabulary never affect the plan", () => {
  const observed = [
    { name: "hourglass_flowing_sand", users: ["ULIV"] },
    { name: "thumbsup", users: ["UHUMAN"] },
    ownTile("raised_hand"),
  ];
  const plan = planStatusTile(observed, { ...SPEC, lifecycle: "raised_hand" });
  assert.equal(plan.unchanged, true);
});

test("reads Slack's canonical name for the aliased ✋ tile", () => {
  const observed = normalizeReactions([{ name: "hand", users: ["ULIV"] }]);
  const plan = planStatusTile(observed, { ...SPEC, lifecycle: "raised_hand" });
  assert.equal(plan.unchanged, true);
});

test("the other agent's ✅ is a bot status, not the human's", () => {
  const maxDone = [{ name: "white_check_mark", users: ["UMAX"] }];
  assert.equal(resolveStatusTile("act", maxDone, new Set(["ULIV", "UMAX"])), "raised_hand");
  const humanDone = [{ name: "white_check_mark", users: ["UHUMAN"] }];
  assert.equal(resolveStatusTile("act", humanDone, new Set(["ULIV", "UMAX"])), "raised_hand");
});

// --- infrastructure ---

test("serializes concurrent run-strip writes for the same root", async () => {
  const queue = createKeyedSerialQueue();
  const order = [];
  const first = queue("root", async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push("first");
  });
  const second = queue("root", async () => {
    order.push("second");
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first", "second"]);
});

test("retries Slack rate limits using retry-after", async () => {
  let calls = 0;
  const slept = [];
  const result = await retrySlackRateLimit(async () => {
    calls += 1;
    if (calls < 3) {
      const error = new Error("rate limit");
      error.data = { error: "ratelimited", retry_after: 1 };
      throw error;
    }
    return "done";
  }, { sleep: async (ms) => slept.push(ms) });
  assert.equal(result, "done");
  assert.equal(calls, 3);
  assert.deepEqual(slept, [1000, 1000]);
});

test("recovers the canonical Slack route from the session key", () => {
  assert.deepEqual(
    slackRouteFromSessionKey("agent:liv:slack:channel:c0bkfafgj72:thread:1787577204.722849"),
    { channel: "C0BKFAFGJ72", rootTs: "1787577204.722849" },
  );
  assert.equal(slackRouteFromSessionKey("agent:liv:main"), undefined);
});

test("asks Slack for the bot user id once per token", async () => {
  let calls = 0;
  const call = async () => { calls += 1; return { user_id: "UBOT" }; };
  const cache = new Map();
  assert.equal(await resolveBotUserId("tok", cache, call), "UBOT");
  assert.equal(await resolveBotUserId("tok", cache, call), "UBOT");
  assert.equal(calls, 1);
});

test("returns no bot id rather than throwing when auth.test fails", async () => {
  const call = async () => { throw new Error("down"); };
  assert.equal(await resolveBotUserId("tok", new Map(), call), undefined);
});

test("form-encodes the Slack call, because JSON bodies fail the read methods", async () => {
  const original = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return { json: async () => ({ ok: true, messages: [] }) };
  };
  try {
    await slackApi("conversations.replies", "tok", { channel: "C0B", ts: "1.2", limit: 1 });
  } finally {
    globalThis.fetch = original;
  }
  assert.match(captured.options.headers["content-type"], /x-www-form-urlencoded/);
  assert.equal(captured.options.body, "channel=C0B&ts=1.2&limit=1");
});

test("resolves the newest Slack package and its hashed runtime chunk", () => {
  const tree = {
    "/proj": ["openclaw-slack-aaa", "openclaw-slack-bbb", "other"],
    "/proj/openclaw-slack-bbb/node_modules/@openclaw/slack/dist": ["actions.runtime-123.js", "accounts.runtime-456.js"],
  };
  const path = resolveSlackRuntimeModule("actions", {
    projectsDir: "/proj",
    list: (dir) => tree[dir] ?? [],
    stat: (path) => ({ mtimeMs: path.endsWith("bbb") ? 2 : 1 }),
  });
  assert.equal(path, "/proj/openclaw-slack-bbb/node_modules/@openclaw/slack/dist/actions.runtime-123.js");
  assert.throws(() => resolveSlackRuntimeModule("actions", { projectsDir: "/proj", list: () => [], stat: () => ({ mtimeMs: 0 }) }));
});

test("resolves Slack 2026.9.8 named exports through the stable runtime API", () => {
  const dist = "/proj/openclaw-slack-current/node_modules/@openclaw/slack/dist";
  const options = {
    projectsDir: "/proj",
    list: (dir) => dir === "/proj" ? ["openclaw-slack-current"] : [
      "actions-fh66A6lc.js", "action-runtime.runtime-CEhbmS-Z.js", "accounts.runtime-DRuEK6mL.js", "runtime-api.js",
    ],
    stat: () => ({ mtimeMs: 1 }),
  };
  for (const kind of ["actions", "accounts"]) {
    assert.equal(resolveSlackRuntimeModule(kind, options), `${dist}/runtime-api.js`);
  }
  assert.throws(() => resolveSlackRuntimeModule("unknown", options), /no unknown runtime chunk/);
});

test("does not substitute an internal Slack chunk with minified exports", () => {
  assert.throws(() => resolveSlackRuntimeModule("actions", {
    projectsDir: "/proj",
    list: (dir) => dir === "/proj" ? ["openclaw-slack-current"] : ["actions-fh66A6lc.js", "action-runtime.runtime-CEhbmS-Z.js"],
    stat: () => ({ mtimeMs: 1 }),
  }), /no actions runtime chunk/);
});

test("a later event without a thinking level keeps the one already known", () => {
  const first = mergeProvenance(undefined, { model: "claude-fable-5", harnessId: "claude-cli", thinkLevel: "high" });
  const second = mergeProvenance(first, { model: "claude-fable-5", provider: "claude-cli" });
  assert.equal(second.thinkLevel, "high");
  assert.equal(second.harnessId, "claude-cli");
});

test("a newer explicit thinking level replaces the remembered one", () => {
  const first = mergeProvenance(undefined, { model: "claude-fable-5", thinkLevel: "high" });
  const second = mergeProvenance(first, { model: "claude-fable-5", thinkLevel: "off" });
  assert.equal(second.thinkLevel, "off");
});

const PROFILE_CONFIG = {
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-5-5": { agentRuntime: { id: "claude-cli" } },
      },
    },
    entries: {
      liv: { model: { primary: "anthropic/claude-opus-5-5" }, runtime: { type: "embedded" } },
    },
  },
};

test("the selected profile harness is carried by run provenance into the reply signature", () => {
  const selected = resolveSelectedHarness(PROFILE_CONFIG, "liv");
  const started = mergeProvenance(undefined, {model: "claude-opus-5-5", provider: "anthropic", harnessId: selected});
  const completed = mergeProvenance(started, {model: "claude-opus-5-5", provider: "claude-cli"});
  assert.deepEqual(buildRunReactionNames(completed).filter((name) => name.startsWith("h_")), ["h_cc"]);
  assert.equal(resolveSelectedHarness(PROFILE_CONFIG, "liv", {agentHarnessId: "codex"}), "codex");
  assert.equal(resolveSelectedHarness({agents: {entries: {liv: {}}}}, "liv", {modelProvider: "claude-cli"}), undefined);
});

test("configured thinking default resolves per agent with a global fallback", () => {
  const config = { agents: { defaults: { thinkingDefault: "low" }, list: [{ id: "max", thinkingDefault: "high" }] } };
  assert.equal(resolveConfiguredThinking(config, "max"), "high");
  assert.equal(resolveConfiguredThinking(config, "MAX"), "high");
  assert.equal(resolveConfiguredThinking(config, "liv"), "low");
  assert.equal(resolveConfiguredThinking(undefined, "max"), undefined);
  assert.equal(resolveConfiguredThinking(config, undefined), undefined);
});

test("resolves the canonical data root explicitly or from an agent workspace", () => {
  const config = { agents: { entries: { liv: { workspace: "/srv/humanware/working/agents/liv" } } } };
  assert.equal(resolveDataRoot(config, {}, "liv", {}), "/srv/humanware");
  assert.equal(resolveDataRoot(config, { dataRoot: "/data" }, "liv", {}), "/data");
  assert.equal(resolveDataRoot({ agents: { entries: { liv: { workspace: "/tmp/liv" } } } }, {}, "liv", {}), undefined);
});

test("resolves Slack DM destinations from the canonical session route", () => {
  const ctx = { sessionKey: "agent:liv:slack:channel:D012ABC:thread:123.456" };
  assert.equal(resolveSlackChannelId({ to: "USER:U012ABC" }, ctx), "D012ABC");
  assert.equal(resolveSlackChannelId({ to: "channel:C012ABC" }, ctx), "C012ABC");
});

test("maps Astra to its Slack model tile", () => {
  assert.equal(resolveModelTile("openai/gpt-6-astra"), ":stars:");
});

test("canonical keyed agents retain their thinking default after migration", () => {
  const config = {agents: {defaults: {thinkingDefault: "low"}, entries: {liv: {thinkingDefault: "high"}}}};
  assert.equal(resolveConfiguredThinking(config, "LIV"), "high");
  assert.equal(resolveConfiguredThinking(config, "max"), "low");
});

test('agent reaction calls cannot add, remove, or clear lifecycle tiles', () => {
  const hooks = new Map();
  runSignaturePlugin.register({config: {}, on: (name, fn) => hooks.set(name, fn)});
  const guard = hooks.get('before_tool_call');
  for (const emoji of ['calendar', ':hand:', '✅', ''])
    assert.equal(guard({toolName: 'message', params: {action: 'react', emoji}}, {}).block, true);
  assert.equal(guard({toolName: 'message', params: {action: 'react', emoji: 'thumbsup'}}, {}), undefined);
});
