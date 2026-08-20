import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {renderAgentContext, renderRuntimeContexts} from "./render-openclaw-agent-context.mjs";

test("renders framework, instance, identity, and data-plane references", () => {
  const rendered = renderAgentContext({
    agentId: "max",
    frameworkRules: "Framework rules.",
    instanceRules: "Owner: Ariel.",
    agentTemplate: "---\nname: max\ndescription: CEO-minded operator\n---\n# Max",
    agentOverlay: "---\nname: Max\nemoji: fox_face\n---\nOwn Ariel Works.",
    runtimeCurrent: "/runtime/current",
    dataRoot: "/data",
  });
  assert.match(rendered["AGENTS.md"], /Framework rules/);
  assert.match(rendered["AGENTS.md"], /Owner: Ariel/);
  assert.match(rendered["SOUL.md"], /Own Ariel Works/);
  assert.match(rendered["SOUL.md"], /\/data\/memory\/current/);
  assert.match(rendered["IDENTITY.md"], /Name: Max/);
  assert.match(rendered["IDENTITY.md"], /Emoji: fox_face/);
});

test("renders every declared agent into the runtime bundle", () => {
  const root = mkdtempSync(join(tmpdir(), "openclaw-context-render-"));
  try {
    mkdirSync(join(root, "config"), {recursive: true});
    mkdirSync(join(root, "instructions", "agents"), {recursive: true});
    mkdirSync(join(root, "instructions", "agent-overlays"), {recursive: true});
    writeFileSync(join(root, "config", "instance.json"), JSON.stringify({agents: ["max"], paths: {runtimeRoot: "/runtime", dataRoot: "/data"}}));
    writeFileSync(join(root, "instructions", "AGENTS.md"), "Framework");
    writeFileSync(join(root, "instructions", "AGENTS-instance.md"), "Instance");
    writeFileSync(join(root, "instructions", "agents", "max.md"), "---\nname: max\n---\nMax");
    writeFileSync(join(root, "instructions", "agent-overlays", "max.md"), "Overlay");
    renderRuntimeContexts(root);
    assert.match(readFileSync(join(root, "instructions", "openclaw", "max", "SOUL.md"), "utf8"), /Overlay/);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
