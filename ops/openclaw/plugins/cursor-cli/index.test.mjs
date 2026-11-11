import test from "node:test";
import assert from "node:assert/strict";
import plugin, {buildCursorCliBackends} from "./index.js";

test("registers the workspace backend against the secret-safe wrapper", () => {
  const backends = buildCursorCliBackends("/runtime/cursor-agent-launch.sh");
  assert.deepEqual(backends.map((entry) => entry.id), ["cursor-agent"]);
  const [agent] = backends;
  assert.equal(agent.config.command, "/runtime/cursor-agent-launch.sh");
  assert.equal(agent.config.jsonlDialect, "claude-stream-json");
  assert.equal(agent.config.serialize, false);
  assert.deepEqual(agent.config.modelAliases, {
    "grok-4.7-low-fast": "grok-4.7-low-fast",
    "grok-4.7-high-fast": "grok-4.7-high-fast"
  });
  assert.deepEqual(agent.config.sessionIdFields, ["session_id"]);
  assert.deepEqual(agent.config.args.slice(0, 2), ["--trust", "--auto-review"]);
  assert.equal(agent.config.args.includes("--mode"), false);
  assert.equal(agent.config.resumeArgs.includes("--mode"), false);
  assert.ok(agent.config.args.includes("--auto-review"));
  assert.ok(agent.config.args.includes("enabled"));
});


test("registers provider bindings without changing the selected backend or command", () => {
  const registered = [];
  plugin.register({pluginConfig: {command: "/runtime/cursor-agent-launch.sh"}, registerCliBackend: (backend) => registered.push(backend)});
  assert.deepEqual(registered.map(({id, modelProvider}) => [id, modelProvider]), [["cursor-agent", "cursor-agent"]]);
  assert.ok(registered.every(backend => backend.config.command === "/runtime/cursor-agent-launch.sh"));
});

// Run against the locally installed reviewed core without loading plugins or state.
test("OpenClaw 11.2 accepts the CLI runtime without requiring a native harness", {skip: !process.env.OPENCLAW_TEST_PACKAGE_ROOT}, async () => {
  const {readFile, readdir} = await import("node:fs/promises");
  const {join} = await import("node:path");
  const {pathToFileURL} = await import("node:url");
  const root = process.env.OPENCLAW_TEST_PACKAGE_ROOT;
  assert.equal(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version, "2026.11.2");
  const files = await readdir(join(root, "dist"));
  async function exportedFunction(prefix, name) {
    const candidates = files.filter(file => file.startsWith(prefix) && /\.m?js$/.test(file));
    for (const file of candidates) {
      const source = await readFile(join(root, "dist", file), "utf8");
      if (!source.includes(`function ${name}(`)) continue;
      const module = await import(pathToFileURL(join(root, "dist", file)).href);
      const fn = Object.values(module).find(value => typeof value === "function" && value.name === name);
      if (fn) return fn;
    }
    throw new Error(`Missing reviewed upstream contract ${name}`);
  }
  const matches = await exportedFunction("cli-backends-", "isCliRuntimeModelBackendForProvider");
  const ensure = await exportedFunction("runtime-plugin-", "ensureSelectedAgentHarnessPlugin");
  const withRegistry = await exportedFunction("gateway-request-scope-", "withPluginRuntimeRegistryScope");
  const registered = buildCursorCliBackends("/runtime/cursor-agent-launch.sh");
  const registry = {
    agentHarnesses: [],
    cliBackends: registered.map(backend => ({backend, pluginId: "cursor-cli", builtWithOpenClawVersion: "2026.11.2"}))
  };
  await withRegistry(registry, async () => {
    for (const backend of registered) {
      assert.equal(matches({provider: backend.id, runtime: backend.id}), true);
      await ensure({provider: backend.id, modelId: "grok-4.7-low-fast", agentHarnessRuntimeOverride: backend.id, config: {}, pluginRegistry: registry});
    }
    assert.equal(matches({provider: "openai", runtime: "cursor-agent"}), false);
  });

  const unboundRegistry = {
    agentHarnesses: [],
    cliBackends: registered.map(({modelProvider, ...backend}) => ({backend, pluginId: "cursor-cli", builtWithOpenClawVersion: "2026.11.2"}))
  };
  await withRegistry(unboundRegistry, async () => {
    assert.equal(matches({provider: "cursor-agent", runtime: "cursor-agent"}), false);
    await assert.rejects(ensure({provider: "cursor-agent", modelId: "grok-4.7-low-fast", agentHarnessRuntimeOverride: "cursor-agent", config: {}, pluginRegistry: unboundRegistry}), /owner-plugin-not-activatable/);
  });
});
