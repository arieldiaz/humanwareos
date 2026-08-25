import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import plugin from "./index.js";

const catalog = {
  schemaVersion: 2,
  defaultProfile: "cursor-low",
  agents: {liv: {defaultProfile: "cursor-low", allowedProfiles: ["cursor-low", "codex-low"]}},
  profiles: {
    "cursor-low": {executionMode: "general", runtime: "cli", harness: "cursor", model: "cursor-ask/grok-low", permissions: "read-only", workspace: "required", dataScope: "tier-2", reasoning: "low", fastMode: true},
    "codex-low": {executionMode: "workspace", runtime: "app-server", harness: "codex", model: "openai/sol", permissions: "standard", workspace: "required", dataScope: "tier-2", reasoning: "low", fastMode: true},
  },
};

test("registers a deterministic route, session state, retry, and delivery ledger", async () => {
  const root = mkdtempSync(join(tmpdir(), "execution-broker-"));
  const catalogPath = join(root, "profiles.json");
  writeFileSync(catalogPath, JSON.stringify(catalog));
  const hooks = new Map();
  let entry = {pluginExtensions: {}};
  const api = {
    id: "execution-broker",
    pluginConfig: {catalogPath, dataRoot: root},
    on(name, handler) { hooks.set(name, handler); },
    runtime: {agent: {session: {
      getSessionEntry() { return entry; },
      async patchSessionEntry({update}) { entry = {...entry, ...update(entry)}; return entry; },
    }}},
  };
  plugin.register(api);
  const ctx = {agentId: "liv", channelId: "slack", sessionKey: "agent:liv:slack:test", runId: "run-1"};
  await hooks.get("inbound_claim")({bodyForAgent: "switch to Codex/Sol low: explain A, compare B, recommend C", messageId: "m1"}, ctx);
  assert.equal(entry.pluginExtensions["execution-broker"].profileId, "codex-low");
  assert.deepEqual(hooks.get("before_model_resolve")({}, ctx), {providerOverride: "openai", modelOverride: "sol"});
  assert.match((await hooks.get("agent_turn_prepare")({}, ctx)).prependContext, /3\. recommend C/);
  assert.equal(hooks.get("before_agent_finalize")({lastAssistantMessage: ""}, ctx).action, "revise");
  await hooks.get("agent_end")({messages: [{role: "assistant", content: "done"}], success: true, durationMs: 5}, ctx);
  await hooks.get("reply_payload_sending")({kind: "final", sessionKey: ctx.sessionKey, runId: ctx.runId, payload: {text: "done"}}, ctx);
  await hooks.get("message_sent")({success: true, sessionKey: ctx.sessionKey, messageId: "out-1"}, {...ctx, runId: undefined});
  const day = new Date().toISOString().slice(0, 10);
  const events = readFileSync(join(root, "evidence", "sessions", "events", `${day}.jsonl`), "utf8");
  assert.match(events, /"kind":"route.resolved"/);
  assert.match(events, /"kind":"delivery.confirmed"/);
});

test("returns a visible failure for an unsupported local route", async () => {
  const root = mkdtempSync(join(tmpdir(), "execution-broker-failure-"));
  const catalogPath = join(root, "profiles.json");
  writeFileSync(catalogPath, JSON.stringify(catalog));
  const hooks = new Map();
  const api = {
    id: "execution-broker",
    pluginConfig: {catalogPath, dataRoot: root},
    on(name, handler) { hooks.set(name, handler); },
    runtime: {agent: {session: {getSessionEntry() { return {}; }, async patchSessionEntry() { return {}; }}}},
  };
  plugin.register(api);
  const result = await hooks.get("inbound_claim")({bodyForAgent: "use Qwen local: answer"}, {agentId: "liv", channelId: "slack", sessionKey: "agent:liv:slack:bad", runId: "run-bad"});
  assert.equal(result.handled, true);
  assert.match(result.reply.text, /could not start this turn/);
  assert.match(result.reply.text, /trace hw-/);
});
