import test from "node:test";
import assert from "node:assert/strict";
import plugin, {buildCursorCliBackends} from "./index.js";

test("registers parallel ask and workspace backends against the secret-safe wrapper", () => {
  const backends = buildCursorCliBackends("/runtime/cursor-agent-launch.sh");
  assert.deepEqual(backends.map((entry) => entry.id), ["cursor-ask", "cursor-agent"]);
  assert.equal(backends[0].config.command, "/runtime/cursor-agent-launch.sh");
  assert.equal(backends[0].config.jsonlDialect, "claude-stream-json");
  assert.equal(backends[0].config.serialize, false);
  assert.deepEqual(backends[0].config.sessionIdFields, ["session_id"]);
  assert.ok(backends[0].config.args.includes("ask"));
  assert.deepEqual(backends[1].config.args.slice(0, 2), ["--trust", "--auto-review"]);
  assert.equal(backends[1].config.args.includes("--mode"), false);
  assert.equal(backends[1].config.resumeArgs.includes("--mode"), false);
  assert.ok(backends[1].config.args.includes("--auto-review"));
  assert.ok(backends[1].config.args.includes("enabled"));
});


test("registers provider bindings without changing the selected backend or command", () => {
  const registered = [];
  plugin.register({pluginConfig: {command: "/runtime/cursor-agent-launch.sh"}, registerCliBackend: (backend) => registered.push(backend)});
  assert.deepEqual(registered.map(({id, modelProvider}) => [id, modelProvider]), [["cursor-ask", "cursor-ask"], ["cursor-agent", "cursor-agent"]]);
  assert.ok(registered.every(backend => backend.config.command === "/runtime/cursor-agent-launch.sh"));
});

// Run against the locally installed reviewed core without loading plugins or state.
test("OpenClaw 9.1 accepts both CLI runtimes without requiring a native harness", {skip: !process.env.OPENCLAW_TEST_PACKAGE_ROOT}, async () => {
  const {readFile, readdir} = await import("node:fs/promises");
  const {join} = await import("node:path");
  const {pathToFileURL} = await import("node:url");
  const root = process.env.OPENCLAW_TEST_PACKAGE_ROOT;
  assert.equal(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version, "2026.9.1");
  const files = await readdir(join(root, "dist"));
  async function exportedFunction(prefix, name) {
    const candidates = files.filter(file => file.startsWith(prefix) && file.endsWith(".js"));
    for (const file of candidates) {
      const source = await readFile(join(root, "dist", file), "utf8");
      if (!source.includes(`function ${name}(`)) continue;
      const module = await import(pathToFileURL(join(root, "dist", file)).href);
      const fn = Object.values(module).find(value => typeof value === "function" && value.name === name);
      if (fn) return fn;
    }
    throw new Error(`Missing reviewed upstream contract ${name}`);
  }
  const previous = process.env.VITEST;
  process.env.VITEST = "1";
  let controls;
  try {
    const matches = await exportedFunction("cli-backends-", "isCliRuntimeModelBackendForProvider");
    controls = globalThis[Symbol.for("openclaw.cliBackendsTestApi")];
    assert.ok(controls);
    const registered = buildCursorCliBackends("/runtime/cursor-agent-launch.sh");
    controls.setDepsForTest({resolveRuntimeCliBackends: () => registered, resolvePluginSetupCliBackend: () => undefined});
    const ensure = await exportedFunction("runtime-plugin-", "ensureSelectedAgentHarnessPlugin");
    for (const backend of registered) {
      assert.equal(matches({provider: backend.id, runtime: backend.id}), true);
      await ensure({provider: backend.id, modelId: "grok-4.6-low-fast", agentHarnessRuntimeOverride: backend.id, config: {}, pluginRegistry: {agentHarnesses: []}});
    }
    assert.equal(matches({provider: "openai", runtime: "cursor-agent"}), false);
    controls.setDepsForTest({resolveRuntimeCliBackends: () => registered.map(({modelProvider, ...backend}) => backend)});
    assert.equal(matches({provider: "cursor-agent", runtime: "cursor-agent"}), false);
    await assert.rejects(ensure({provider: "cursor-agent", modelId: "grok-4.6-low-fast", agentHarnessRuntimeOverride: "cursor-agent", config: {}, pluginRegistry: {agentHarnesses: []}}), /owner-plugin-not-activatable/);
  } finally {
    controls?.resetDepsForTest();
    if (previous === undefined) delete process.env.VITEST;
    else process.env.VITEST = previous;
  }
});
