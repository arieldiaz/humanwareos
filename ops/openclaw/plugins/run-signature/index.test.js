import assert from "node:assert/strict";
import test from "node:test";

import {
  addReactionsInOrder,
  slackApi,
  buildRunReactionNames,
  buildRunSignature,
  createKeyedSerialQueue,
  createToolFailureDeduper,
  planStatusTile,
  resolveHarnessTile,
  resolveModelTile,
  normalizeOutboundStatus,
  resolveStatusTile,
  resolveThreadRoot,
  rememberInboundThreadRoot,
  rememberAcpBoundThread,
  boundThreadFromSession,
  sessionBoundThread,
  acpProjectionDecision,
  extractPublishedReply,
  isAcpBindingSession,
  resolveBotUserId,
  sessionKeyForRoot,
  routeCacheKey,
  resolveConfiguredThinking,
  redactSlackReferences,
  slackRouteFromSessionKey,
  resolveConfiguredAcpProvenance,
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
  assert.equal(hooks.includes("before_tool_call"), false);
  assert.ok(hooks.includes("reply_payload_sending"));
  assert.ok(hooks.includes("message_sending"));
  assert.ok(hooks.includes("message_sent"));
});

test("suppresses a synthesized tool warning only after a human final in the same run", () => {
  let current = 1_000;
  const deduper = createToolFailureDeduper({ now: () => current, retentionMs: 10_000 });
  const human = { kind: "final", runId: "run-1", payload: { text: "The release failed validation; fix the URL." } };
  const raw = { kind: "final", runId: "run-1", payload: { text: "⚠️ 🛠️ Bash failed: `gh run watch` (exit 1)", isError: true } };

  assert.equal(deduper.shouldSuppress(raw), false);
  deduper.recordHumanFinal(human);
  assert.equal(deduper.shouldSuppress(raw), true);
  assert.equal(deduper.shouldSuppress(raw), false);

  deduper.recordHumanFinal(human);
  assert.equal(deduper.shouldSuppress({ ...raw, runId: "run-2" }), false);
  assert.equal(deduper.shouldSuppress({ ...raw, payload: { text: "The release failed validation.", isError: true } }), false);
  current += 10_001;
  assert.equal(deduper.shouldSuppress(raw), false);
});

// --- explicit outbound status ---

test("normalizes legacy Status forms without exposing transport prose", () => {
  const cases = [
    ["Human — answer: Approve it.", "answer", "## ❓ Clarify\nApprove it."],
    ["Human — act: Complete the vendor check.", "act", "## ✋ Act\nComplete the vendor check."],
    ["Agent — working: Running verification.", "working", ""],
    ["Scheduled: Resurfaces Monday.", "scheduled", "## 🗓️ Scheduled\nResurfaces Monday."],
    ["No action needed.", "no_action", ""],
    ["Session closed.", "closed", "## Session Closed"],
  ];
  for (const [body, status, lifecycle] of cases) {
    const normalized = normalizeOutboundStatus(`## TLDR\nResult.\n\n## Status\n${body}`);
    assert.equal(normalized.status, status);
    assert.equal(normalized.content, ["## TLDR\nResult.", lifecycle].filter(Boolean).join("\n\n"));
    assert.doesNotMatch(normalized.content, /## Status/);
  }
});

test("an ordinary reply creates no obligation without inspecting its prose", () => {
  assert.deepEqual(normalizeOutboundStatus("Completed the fix."), {
    status: "no_action",
    content: "Completed the fix.",
  });
  assert.deepEqual(normalizeOutboundStatus("## Status\nMaybe waiting"), {
    status: "no_action",
    content: "## Status\nMaybe waiting",
  });
  assert.equal(resolveStatusTile(normalizeOutboundStatus("Completed the fix.").status, [], new Set()), undefined);
});

test("typed status wins without parsing reply prose", () => {
  assert.deepEqual(normalizeOutboundStatus("Verification is running.", { explicitStatus: "working" }), {
    status: "working",
    content: "Verification is running.",
  });
});

test("explicit transport status wins over earlier lifecycle prose", () => {
  const normalized = normalizeOutboundStatus("## ❓ Clarify\nOld prose\n\n## Status\nNo action needed.");
  assert.equal(normalized.status, "no_action");
  assert.match(normalized.content, /## ❓ Clarify/);
  assert.doesNotMatch(normalized.content, /## Status/);
});

test("lifecycle headings map directly without being rewritten", () => {
  const cases = [
    ["## ❓ Clarify\nWhich list?", "answer"],
    ["## ✋ Act\nComplete the identity check.", "act"],
    ["## 🗓️ Scheduled\nMonday at 9.", "scheduled"],
    ["## Session Closed", "closed"],
  ];
  for (const [body, status] of cases) {
    const normalized = normalizeOutboundStatus(body);
    assert.equal(normalized.status, status);
    assert.equal(normalized.content, body);
  }
});

test("a human ✅ on the root is closed and outranks the outbound status", () => {
  const reactions = [{ name: "white_check_mark", users: ["UHUMAN"] }];
  assert.equal(resolveStatusTile("answer", reactions, "UBOT"), "white_check_mark");
  const botOnly = [{ name: "white_check_mark", users: ["UBOT"] }];
  assert.equal(resolveStatusTile("answer", botOnly, "UBOT"), "question");
  assert.equal(resolveStatusTile("answer", [], "UBOT"), "question");
});

test("each footer value drives its exact root-tile transition", () => {
  const cases = [
    ["Human — answer: Decide.", "question"],
    ["Human — act: Complete it.", "raised_hand"],
    ["Agent — working: Continuing.", "arrows_counterclockwise"],
    ["Scheduled: Monday.", "calendar"],
    ["No action needed.", undefined],
    ["Session closed.", "white_check_mark"],
  ];
  for (const [body, expected] of cases) {
    const { status } = normalizeOutboundStatus(`Result.\n\n## Status\n${body}`);
    const lifecycle = resolveStatusTile(status, [], SPEC.botUserIds);
    const plan = planStatusTile([ownTile("arrows_counterclockwise")], { ...SPEC, lifecycle });
    assert.equal(addNames(plan)[0], expected === "arrows_counterclockwise" ? undefined : expected);
    if (expected === "arrows_counterclockwise") assert.equal(plan.unchanged, true);
  }
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
  const plan = planStatusTile([], { ...SPEC, lifecycle: "question" });
  assert.deepEqual(addNames(plan), ["question"]);
  assert.deepEqual(plan.remove, []);
});

test("a correct status tile is a strict no-op", () => {
  const plan = planStatusTile([ownTile("question")], { ...SPEC, lifecycle: "question" });
  assert.equal(plan.unchanged, true);
  assert.deepEqual(plan.add, []);
  assert.deepEqual(plan.remove, []);
});

test("a lifecycle transition swaps the one tile", () => {
  const plan = planStatusTile([ownTile("question")], { ...SPEC, lifecycle: "raised_hand" });
  assert.deepEqual(removeNames(plan), ["question"]);
  assert.deepEqual(addNames(plan), ["raised_hand"]);
});

test("no action clears a stale working tile", () => {
  const plan = planStatusTile([ownTile("arrows_counterclockwise")], { ...SPEC, lifecycle: undefined });
  assert.deepEqual(removeNames(plan), ["arrows_counterclockwise"]);
  assert.deepEqual(plan.add, []);
});

test("legacy provenance tiles are cleaned up on the next send, per holder", () => {
  const observed = [
    { name: "butterfly", users: ["ULIV"] },
    { name: "h_cc", users: ["ULIV"] },
    { name: "m_fable", users: ["ULIV"] },
    { name: "think_off", users: ["ULIV"] },
    { name: "fox_face", users: ["UMAX"] },
    { name: "m_gpt_sol", users: ["UMAX"] },
    { name: "question", users: ["ULIV"] },
  ];
  const plan = planStatusTile(observed, { ...SPEC, lifecycle: "question" });
  assert.deepEqual(removeNames(plan).sort(), ["butterfly", "fox_face", "h_cc", "m_fable", "m_gpt_sol", "think_off"]);
  const fox = plan.remove.find((item) => item.name === "fox_face");
  assert.deepEqual(fox.holders, ["UMAX"]);
  assert.deepEqual(plan.add, []);
});

test("a retired lifecycle tile is dropped, not preserved", () => {
  const plan = planStatusTile([ownTile("no_entry_sign")], { ...SPEC, lifecycle: "question" });
  assert.deepEqual(removeNames(plan), ["no_entry_sign"]);
  assert.deepEqual(addNames(plan), ["question"]);
});

test("a human-held lifecycle tile owns the state; the bot adds nothing beside it", () => {
  const observed = [{ name: "white_check_mark", users: ["UHUMAN"] }];
  const plan = planStatusTile(observed, { ...SPEC, lifecycle: "white_check_mark" });
  assert.equal(plan.unchanged, true);
});

test("a stale bot status is dropped when the human's ✅ owns the state", () => {
  const observed = [
    { name: "question", users: ["ULIV"] },
    { name: "white_check_mark", users: ["UHUMAN"] },
  ];
  const plan = planStatusTile(observed, { ...SPEC, lifecycle: "white_check_mark" });
  assert.deepEqual(removeNames(plan), ["question"]);
  assert.deepEqual(plan.add, []);
});

test("the other agent's status tile is replaced with its own token", () => {
  const observed = [{ name: "question", users: ["UMAX"] }];
  const plan = planStatusTile(observed, { ...SPEC, lifecycle: "raised_hand" });
  const question = plan.remove.find((item) => item.name === "question");
  assert.deepEqual(question.holders, ["UMAX"]);
  assert.deepEqual(addNames(plan), ["raised_hand"]);
});

test("a status tile shared by human and bot keeps the human copy only", () => {
  const observed = [{ name: "white_check_mark", users: ["UHUMAN", "ULIV"] }];
  const plan = planStatusTile(observed, { ...SPEC, lifecycle: "white_check_mark" });
  assert.deepEqual(removeNames(plan), ["white_check_mark"]);
  const tile = plan.remove[0];
  assert.deepEqual(tile.holders, ["ULIV"]);
  assert.deepEqual(plan.add, []);
});

test("a human-held provenance tile is never touched", () => {
  const observed = [
    { name: "butterfly", users: ["UHUMAN"] },
    { name: "question", users: ["ULIV"] },
  ];
  const plan = planStatusTile(observed, { ...SPEC, lifecycle: "question" });
  assert.equal(plan.unchanged, true);
});

test("reactions outside the strip vocabulary never affect the plan", () => {
  const observed = [
    { name: "hourglass_flowing_sand", users: ["ULIV"] },
    { name: "thumbsup", users: ["UHUMAN"] },
    ownTile("question"),
  ];
  const plan = planStatusTile(observed, { ...SPEC, lifecycle: "question" });
  assert.equal(plan.unchanged, true);
});

test("reads Slack's canonical name for the aliased ✋ tile", () => {
  const observed = normalizeReactions([{ name: "hand", users: ["ULIV"] }]);
  const plan = planStatusTile(observed, { ...SPEC, lifecycle: "raised_hand" });
  assert.equal(plan.unchanged, true);
});

test("the other agent's ✅ is a bot close, not the human's", () => {
  const maxDone = [{ name: "white_check_mark", users: ["UMAX"] }];
  assert.equal(resolveStatusTile("answer", maxDone, new Set(["ULIV", "UMAX"])), "question");
  const humanDone = [{ name: "white_check_mark", users: ["UHUMAN"] }];
  assert.equal(resolveStatusTile("answer", humanDone, new Set(["ULIV", "UMAX"])), "white_check_mark");
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

test("keeps raw Slack timestamps out of user-visible prose", () => {
  assert.equal(
    redactSlackReferences("The root 1787577204.722849 differed from 1787581296.983059."),
    "The root internal Slack reference differed from internal Slack reference.",
  );
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

test("drops ACP work narration and keeps the polished reply", () => {
  assert.equal(isAcpBindingSession("agent:liv:acp:binding:slack:liv:abc"), true);
  assert.equal(isAcpBindingSession("agent:liv:slack:channel:c0b:thread:1.1"), false);
  assert.equal(acpProjectionDecision("final", "I'll check the plugin next.").deliver, false);
  assert.equal(acpProjectionDecision("block", "Closing this now.").deliver, false);
  assert.equal(
    acpProjectionDecision("final", "Working the Claude cutover, this will take a few minutes.").deliver,
    true,
  );
  const mixed = "I'll orient on the thread.\n\n## TLDR\nDone.\n\n## Status\nNo action needed.";
  assert.equal(extractPublishedReply(mixed), "## TLDR\nDone.\n\n## Status\nNo action needed.");
  assert.deepEqual(acpProjectionDecision("final", mixed), {
    deliver: true,
    text: "## TLDR\nDone.\n\n## Status\nNo action needed.",
  });
});
