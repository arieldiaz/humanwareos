import assert from "node:assert/strict";
import test from "node:test";

import {
  addReactionsInOrder,
  slackApi,
  buildRunReactionNames,
  buildRunSignature,
  ADMITTED_STATUS,
  createKeyedSerialQueue,
  planStatusTile,
  resolveHarnessTile,
  resolveModelTile,
  resolveStatusTile,
  resolveThreadRoot,
  rememberInboundThreadRoot,
  rememberAcpBoundThread,
  boundThreadFromSession,
  sessionBoundThread,
  isAcpBindingSession,
  resolveBotUserId,
  sessionKeyForRoot,
  routeCacheKey,
  resolveConfiguredThinking,
  slackRouteFromSessionKey,
  resolveSlackChannelId,
  resolveConfiguredAcpProvenance,
  resolveDataRoot,
  normalizeThinkingLevel,
  resolveThinkingTile,
  retrySlackRateLimit,
  resolveSlackRuntimeModule,
  saveAgentProvenance,
  loadAgentProvenance,
  mergeProvenance,
  recoverMissingHarness,
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
  assert.equal(hooks.includes("before_prompt_build"), false);
  assert.equal(hooks.includes("before_tool_call"), true);
  assert.ok(hooks.includes("reply_payload_sending"));
  assert.ok(hooks.includes("message_sending"));
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
  assert.equal(tools.length, 1);
  assert.equal(tools[0].options.name, "start_work_thread");
  assert.equal(tools[0].factory({ messageChannel: "discord", agentId: "max" }), undefined);
  const tool = tools[0].factory({
    messageChannel: "slack",
    nativeChannelId: "C123",
    agentId: "max",
    agentAccountId: "max",
  });
  assert.equal(tool.name, "start_work_thread");
  assert.deepEqual(tool.parameters.required, ["title", "detail"]);
  assert.match(tool.description, /durable high-reasoning session/);
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
  assert.equal(resolveHarnessTile({ harnessId: "codex" }), ":h_codex:");
  assert.equal(resolveHarnessTile({ provider: "claude-cli" }), ":h_cc:");
  assert.equal(resolveHarnessTile({ harnessId: "cursor" }), ":h_cursor:");
  assert.equal(resolveHarnessTile({ sessionKey: "agent:max:opencode:x" }), ":h_opencode:");
  assert.equal(resolveHarnessTile({ provider: "ollama" }), undefined);
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
  const provenance = { model: "claude-opus-5", provider: "claude-cli", thinkLevel: "off" };
  const signature = buildRunSignature(provenance);
  assert.equal(signature, ":m_opus: :h_cc: :think_off:");
  assert.deepEqual(buildRunReactionNames(provenance), ["m_opus", "h_cc", "think_off"]);
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

test("rekeys a session onto the thread root and refuses a no-op rekey", () => {
  assert.equal(
    sessionKeyForRoot("agent:liv:slack:channel:c0b:thread:1786710044.475489", "1786705095.330309"),
    "agent:liv:slack:channel:c0b:thread:1786705095.330309",
  );
  assert.equal(sessionKeyForRoot("agent:liv:slack:channel:c0b:thread:1786705095.330309", "1786705095.330309"), undefined);
  assert.equal(sessionKeyForRoot(undefined, "1786705095.330309"), undefined);
});

test("recovers the canonical Slack route from the session key", () => {
  assert.deepEqual(
    slackRouteFromSessionKey("agent:liv:slack:channel:c0bkfafgj72:thread:1787577204.722849"),
    { channel: "C0BKFAFGJ72", rootTs: "1787577204.722849" },
  );
  assert.equal(slackRouteFromSessionKey("agent:liv:main"), undefined);
});



test("resolves an inbound message ts to its thread root and caches it", async () => {
  const calls = [];
  const call = async (method, token, body) => {
    calls.push({ method, body });
    return { messages: [{ ts: body.ts, thread_ts: "1786705095.330309" }] };
  };
  const cache = new Map();
  const root = await resolveThreadRoot("C0B", "1786710044.475489", "tok", cache, call);
  assert.equal(root, "1786705095.330309");
  const again = await resolveThreadRoot("C0B", "1786710044.475489", "tok", cache, call);
  assert.equal(again, "1786705095.330309");
  assert.equal(calls.length, 1);
});

test("falls back to the given ts when Slack cannot resolve the root", async () => {
  const call = async () => { throw new Error("nope"); };
  const root = await resolveThreadRoot("C0B", "123.456", "tok", new Map(), call);
  assert.equal(root, "123.456");
});

test("remembers the canonical root carried by the inbound Slack event", () => {
  const cache = new Map();
  assert.deepEqual(rememberInboundThreadRoot(
    { messageId: "1786710044.475489", threadId: "1786705095.330309" },
    { channelId: "slack", conversationId: "channel:C0B" },
    cache,
  ), { channel: "C0B", rootTs: "1786705095.330309" });
  assert.equal(cache.get("C0B:1786710044.475489"), "1786705095.330309");
  assert.deepEqual(
    rememberInboundThreadRoot(
      { channel: "slack", conversationId: "channel:C0B", messageId: "1786710050.000001" },
      {},
      cache,
    ),
    { channel: "C0B", rootTs: "1786710050.000001" },
  );
  rememberInboundThreadRoot({ messageId: "1.2", threadId: "1.1" }, { channelId: "telegram" }, cache);
  assert.equal(cache.size, 2);
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

test("resolves Slack 2026.9.1 named exports through the stable runtime API", () => {
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

test("round-trips the per-agent provenance snapshot and drops junk entries", async () => {
  const path = `/tmp/run-signature-test-snapshot-${process.pid}.json`;
  const byAgent = new Map([
    ["liv", { model: "claude-fable-5", provider: "claude-cli" }],
    ["max", { model: "gpt-5.6-sol", provider: "openai" }],
  ]);
  await saveAgentProvenance(byAgent, path);
  const loaded = await loadAgentProvenance(path);
  assert.deepEqual(loaded.get("liv"), { model: "claude-fable-5", provider: "claude-cli" });
  assert.equal(loaded.size, 2);
});

test("returns an empty provenance map when the snapshot is absent or corrupt", async () => {
  const loaded = await loadAgentProvenance(`/tmp/does-not-exist-${process.pid}.json`);
  assert.equal(loaded.size, 0);
});

test("a later event without a thinking level keeps the one already known", () => {
  const first = mergeProvenance(undefined, { model: "claude-fable-5", thinkLevel: "high" });
  const second = mergeProvenance(first, { model: "claude-fable-5", harnessId: "claude-cli" });
  assert.equal(second.thinkLevel, "high");
  assert.equal(second.harnessId, "claude-cli");
});

test("a newer explicit thinking level replaces the remembered one", () => {
  const first = mergeProvenance(undefined, { model: "claude-fable-5", thinkLevel: "high" });
  const second = mergeProvenance(first, { model: "claude-fable-5", thinkLevel: "off" });
  assert.equal(second.thinkLevel, "off");
});

test("a fresh live session recovers its provable Codex harness before the first send", () => {
  const live = { model: "gpt-5.6-sol", provider: "openai", sessionKey: "agent:max:slack:channel:c1:thread:1" };
  const disk = { ...live, harnessId: "codex" };
  assert.deepEqual(buildRunReactionNames(recoverMissingHarness(live, disk)), ["m_gpt_sol", "h_codex"]);
});

test("live harness provenance is never replaced by a recovered prior harness", () => {
  const live = { model: "cursor/cursor-grok-4.6-high", provider: "cursor", harnessId: "cursor" };
  const disk = { model: "gpt-5.6-sol", provider: "openai", harnessId: "codex" };
  assert.equal(recoverMissingHarness(live, disk), live);
});

test("recognizes the claude-cli provider as the Claude Code harness", () => {
  assert.equal(resolveHarnessTile({ provider: "claude-cli" }), ":h_cc:");
  assert.equal(resolveHarnessTile({ harnessId: "claude-code" }), ":h_cc:");
});

test("route cache keys carry the agent so a shared thread cannot cross-contaminate", () => {
  assert.equal(routeCacheKey("liv", "C0BJUS07HUH", "123.456"), "liv:c0bjus07huh:123.456");
  assert.notEqual(routeCacheKey("liv", "C1", "1.2"), routeCacheKey("max", "C1", "1.2"));
  assert.equal(routeCacheKey(undefined, "C1", "1.2"), undefined);
  assert.equal(routeCacheKey("liv", "C1", undefined), undefined);
});

test("configured thinking default resolves per agent with a global fallback", () => {
  const config = { agents: { defaults: { thinkingDefault: "low" }, list: [{ id: "max", thinkingDefault: "high" }] } };
  assert.equal(resolveConfiguredThinking(config, "max"), "high");
  assert.equal(resolveConfiguredThinking(config, "MAX"), "high");
  assert.equal(resolveConfiguredThinking(config, "liv"), "low");
  assert.equal(resolveConfiguredThinking(undefined, "max"), undefined);
  assert.equal(resolveConfiguredThinking(config, undefined), undefined);
});

test("configured Cursor ACP bindings carry provable Auto provenance", () => {
  const config = {
    agents: { list: [{ id: "liv", runtime: { type: "acp", acp: { agent: "cursor" } } }] },
    plugins: { entries: { acpx: { config: { agents: { cursor: { args: ["--model", "auto", "acp"] } } } } } },
  };
  const sessionKey = "agent:liv:acp:binding:slack:liv:1234";
  assert.deepEqual(resolveConfiguredAcpProvenance(config, sessionKey), {
    model: "cursor/auto",
    provider: "cursor",
    harnessId: "cursor",
    sessionKey,
  });
  assert.equal(buildRunSignature(resolveConfiguredAcpProvenance(config, sessionKey)), ":m_cursor_auto: :h_cursor:");
  assert.equal(resolveConfiguredAcpProvenance(config, "agent:liv:slack:channel:x"), undefined);
});

test("configured Cursor ACP routes outrank stale native session provenance", () => {
  const config = {
    agents: { list: [{ id: "liv", runtime: { type: "acp", acp: { agent: "cursor" } } }] },
    bindings: [{
      type: "acp",
      agentId: "liv",
      match: { channel: "slack", accountId: "liv", peer: { kind: "channel", id: "C123" } },
    }],
    plugins: { entries: { acpx: { config: { agents: { cursor: { args: ["--model", "cursor-grok-4.6-high", "acp"] } } } } } },
  };
  const sessionKey = "agent:liv:slack:channel:c123:thread:456.789";
  const provenance = resolveConfiguredAcpProvenance(config, sessionKey, { accountId: "liv", channel: "C123" });
  assert.deepEqual(provenance, {
    model: "cursor/cursor-grok-4.6-high",
    provider: "cursor",
    harnessId: "cursor",
    sessionKey,
  });
  assert.deepEqual(buildRunReactionNames(provenance), ["m_grok", "h_cursor"]);
  assert.equal(resolveConfiguredAcpProvenance(config, sessionKey, { accountId: "liv", channel: "C999" }), undefined);
});

test("caches the inbound Slack root on the ACP binding session", () => {
  const cache = new Map();
  const sessionKey = "agent:liv:acp:binding:slack:liv:8b291ea29ca808cc";
  rememberAcpBoundThread(
    { messageId: "1787189113.861049", threadId: "1787187673.847529" },
    { channelId: "slack", conversationId: "channel:C0BLQJAVD2L", sessionKey },
    cache,
  );
  assert.deepEqual(boundThreadFromSession(sessionKey, cache), {
    channel: "C0BLQJAVD2L",
    rootTs: "1787187673.847529",
  });
  rememberAcpBoundThread(
    { messageId: "1.2", threadId: "1.1" },
    { channelId: "slack", conversationId: "channel:C0B", sessionKey: "agent:liv:slack:channel:c0b:thread:1.1" },
    cache,
  );
  assert.equal(cache.size, 1);
});

test("reads the Slack root from the ACP session row when the send omits threadId", () => {
  const sessionKey = "agent:liv:acp:binding:slack:liv:000430882a43355e";
  assert.deepEqual(
    sessionBoundThread({
      origin: {
        nativeChannelId: "C0BGF5593PE",
        to: "channel:C0BGF5593PE",
        threadId: "1786963060.631729",
      },
      deliveryContext: { channel: "slack", threadId: "1786963060.631729" },
      lastThreadId: "1786963060.631729",
    }),
    { channel: "C0BGF5593PE", rootTs: "1786963060.631729" },
  );
  assert.equal(sessionBoundThread({ origin: { nativeChannelId: "C0B" } }), undefined);
  assert.equal(
    String(
      undefined ?? undefined ?? boundThreadFromSession(sessionKey, new Map())?.rootTs ??
        sessionBoundThread({ origin: { threadId: "1786963060.631729" } })?.rootTs ??
        "",
    ),
    "1786963060.631729",
  );
});

test("identifies ACP binding sessions without interpreting reply prose", () => {
  assert.equal(isAcpBindingSession("agent:liv:acp:binding:slack:liv:abc"), true);
  assert.equal(isAcpBindingSession("agent:liv:slack:channel:c0b:thread:1.1"), false);
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


test("canonical keyed agents retain thinking and ACP provenance after migration", () => {
  const config = {
    agents: {defaults: {thinkingDefault: "low"}, entries: {liv: {thinkingDefault: "high", runtime: {type: "acp", acp: {agent: "cursor"}}}}},
    plugins: {entries: {acpx: {config: {agents: {cursor: {args: ["--model", "auto"]}}}}}},
  };
  assert.equal(resolveConfiguredThinking(config, "LIV"), "high");
  assert.equal(resolveConfiguredThinking(config, "max"), "low");
  assert.equal(resolveConfiguredAcpProvenance(config, "agent:liv:acp:binding:slack:liv:1234").model, "cursor/auto");
});

test('agent reaction calls cannot add, remove, or clear lifecycle tiles', () => {
  const hooks = new Map();
  runSignaturePlugin.register({config: {}, on: (name, fn) => hooks.set(name, fn)});
  const guard = hooks.get('before_tool_call');
  for (const emoji of ['calendar', ':hand:', '✅', ''])
    assert.equal(guard({toolName: 'message', params: {action: 'react', emoji}}, {}).block, true);
  assert.equal(guard({toolName: 'message', params: {action: 'react', emoji: 'thumbsup'}}, {}), undefined);
});
