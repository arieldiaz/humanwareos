import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

import {applyRuntimeProfiles} from "./render-openclaw-runtime-profiles.mjs";

const source = {
  agents: {
    defaults: {
      models: {
        "openai/gpt-5.6-sol": {alias: "sol"},
        "openai/old": {alias: "retired"},
        "local/fallback": {alias: "local"},
      },
    },
    list: [
      {id: "liv", workspace: "/data/liv", model: {primary: "openai/old", fallbacks: ["local/fallback"]}},
      {id: "max", workspace: "/data/max", model: {primary: "openai/old"}},
    ],
  },
  bindings: [
    {type: "route", agentId: "liv", match: {channel: "slack", accountId: "liv"}},
    {type: "route", agentId: "max", match: {channel: "slack", accountId: "max"}},
  ],
  plugins: {
    entries: {
      acpx: {config: {agents: {cursor: {command: "cursor-agent", args: ["--trust", "--model", "old-model", "acp"]}}}},
    },
  },
};

const catalog = {
  schemaVersion: 2,
  defaultProfile: "native",
  agents: {
    liv: {
      defaultProfile: "cursor",
      escalationProfile: "cursor-deep",
      allowedProfiles: ["native", "cursor", "cursor-deep"],
    },
    max: {defaultProfile: "native", escalationProfile: "native-deep", allowedProfiles: ["native", "native-deep", "cursor"]},
  },
  profiles: {
    native: {executionMode: "general", runtime: "native", harness: "openclaw", model: "openai/gpt-5.6-sol", reasoning: "medium", fastMode: true},
    "native-deep": {executionMode: "general", runtime: "native", harness: "openclaw", model: "openai/gpt-5.6-sol", reasoning: "high", fastMode: false},
    cursor: {executionMode: "workspace", runtime: "acp", harness: "cursor", model: "cursor/grok-medium", workspace: "required", reasoning: "medium", fastMode: true},
    "cursor-deep": {executionMode: "workspace", runtime: "acp", harness: "cursor-deep", model: "cursor/grok-high", workspace: "required", reasoning: "high", fastMode: true},
  },
};

test("renders each agent's selected profile into effective OpenClaw config", () => {
  const rendered = applyRuntimeProfiles(source, catalog);
  assert.deepEqual(rendered.agents.list[0].runtime, {
    type: "acp",
    acp: {agent: "cursor", backend: "acpx", mode: "persistent", cwd: "/data/liv"},
  });
  assert.equal(rendered.agents.list[0].thinkingDefault, "medium");
  assert.equal(rendered.agents.list[0].fastModeDefault, true);
  assert.deepEqual(rendered.agents.list[1].runtime, {type: "embedded"});
  assert.equal(rendered.agents.list[1].model.primary, "openai/gpt-5.6-sol");
  assert.equal(rendered.agents.list[1].thinkingDefault, "medium");
  assert.equal(rendered.agents.list[1].fastModeDefault, true);
  assert.equal(rendered.agents.list[0].model.primary, "openai/old");
  assert.deepEqual(rendered.plugins.entries.acpx.config.agents.cursor.args, ["--trust", "--model", "cursor/grok-medium", "acp"]);
  assert.equal(rendered.bindings[0].type, "route");
  assert.deepEqual(rendered.agents.list[1].models["openai/gpt-5.6-sol"].agentRuntime, {id: "openclaw"});
  assert.deepEqual(Object.keys(rendered.agents.defaults.models), ["openai/gpt-5.6-sol"]);
  assert.deepEqual(rendered.agents.defaults.models["openai/gpt-5.6-sol"], {alias: "sol", agentRuntime: {id: "openclaw"}});
});

test("keeps the reference instance on the native interactive path by default", () => {
  const templatePath = fileURLToPath(new URL("../templates/instance/runtime/profiles.json", import.meta.url));
  const template = JSON.parse(readFileSync(templatePath, "utf8"));
  const rendered = applyRuntimeProfiles(source, template);

  assert.equal(template.defaultProfile, "native-low");
  for (const agent of rendered.agents.list) {
    assert.equal(template.agents[agent.id].defaultProfile, "native-low");
    assert.equal(template.profiles[template.agents[agent.id].defaultProfile].executionMode, "general");
    assert.deepEqual(agent.runtime, {type: "embedded"});
    assert.equal(agent.model.primary, "openai/gpt-5.6-sol");
  }
});

test("exposes every allowed CLI profile through OpenClaw model visibility", () => {
  const cliCatalog = structuredClone(catalog);
  cliCatalog.profiles.cursor = {
    executionMode: "general",
    runtime: "cli",
    harness: "cursor",
    backend: "cursor-ask",
    model: "cursor-ask/grok-4.6-low-fast",
    reasoning: "low",
    fastMode: true,
  };
  cliCatalog.profiles["cursor-deep"] = {
    ...cliCatalog.profiles.cursor,
    model: "cursor-ask/grok-4.6-high-fast",
    reasoning: "high",
  };

  const rendered = applyRuntimeProfiles(source, cliCatalog);
  assert.deepEqual(Object.keys(rendered.agents.defaults.models).sort(), [
    "cursor-ask/grok-4.6-high-fast",
    "cursor-ask/grok-4.6-low-fast",
    "openai/gpt-5.6-sol",
  ]);
  assert.deepEqual(rendered.agents.defaults.models["cursor-ask/grok-4.6-high-fast"].agentRuntime, {id: "cursor-ask"});
  assert.equal(rendered.agents.defaults.models["local/fallback"], undefined);
});

test("rejects a profile outside the agent allowlist", () => {
  const invalid = structuredClone(catalog);
  invalid.agents.liv.allowedProfiles = ["native"];
  assert.throws(() => applyRuntimeProfiles(source, invalid), /cannot select profile cursor/);
});

test("rejects a disabled selected profile", () => {
  const invalid = structuredClone(catalog);
  invalid.profiles.cursor.enabled = false;
  assert.throws(() => applyRuntimeProfiles(source, invalid), /selected disabled profile cursor/);
});

test("rejects an escalation profile outside the agent allowlist", () => {
  const invalid = structuredClone(catalog);
  invalid.agents.liv.allowedProfiles = ["native", "cursor"];
  assert.throws(() => applyRuntimeProfiles(source, invalid), /cannot escalate to profile cursor-deep/);
});

test("rejects wildcard ACP bindings", () => {
  const invalidSource = structuredClone(source);
  invalidSource.bindings.unshift({type: "acp", agentId: "liv", match: {channel: "slack", accountId: "liv", peer: {kind: "channel", id: "*"}}});
  assert.throws(() => applyRuntimeProfiles(invalidSource, catalog), /wildcard ACP bindings are prohibited/);
});

test("runs through an immutable-runtime symlink path", () => {
  const directory = mkdtempSync(join(tmpdir(), "runtime-profile-renderer-"));
  try {
    const script = fileURLToPath(new URL("./render-openclaw-runtime-profiles.mjs", import.meta.url));
    const linkedScript = join(directory, "renderer.mjs");
    const sourcePath = join(directory, "source.json");
    const profilesPath = join(directory, "profiles.json");
    const outputPath = join(directory, "rendered.json");
    symlinkSync(script, linkedScript);
    writeFileSync(sourcePath, JSON.stringify(source));
    writeFileSync(profilesPath, JSON.stringify(catalog));

    const result = spawnSync(process.execPath, [linkedScript, sourcePath, profilesPath, outputPath], {encoding: "utf8"});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(outputPath, "utf8")).agents.list[0].runtime.type, "acp");
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
