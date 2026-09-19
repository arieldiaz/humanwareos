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
    responseContract: "Use ## TLDR for substantive replies.",
    agentTemplate: "---\nname: max\ndescription: CEO-minded operator\n---\n# Max",
    agentOverlay: "---\nname: Max\nemoji: fox_face\n---\nOwn Ariel Works.",
    runtimeCurrent: "/runtime/current",
    dataRoot: "/data",
  });
  assert.match(rendered["AGENTS.md"], /Framework rules/);
  assert.match(rendered["AGENTS.md"], /Owner: Ariel/);
  assert.match(rendered["AGENTS.md"], /Canonical response envelope[\s\S]*Use ## TLDR/);
  assert.match(rendered["SOUL.md"], /Own Ariel Works/);
  assert.match(rendered["SOUL.md"], /\/data\/current\/memory/);
  assert.doesNotMatch(rendered["SOUL.md"], /Before every Slack reply, read/);
  assert.match(rendered["IDENTITY.md"], /Name: Max/);
  assert.match(rendered["IDENTITY.md"], /Emoji: fox_face/);
  assert.match(rendered["MEMORY.md"], /\/data\/current\/memory/);
  assert.match(rendered["STRATEGY.md"], /\/data\/current\/strategy\/current\.md/);
});

test("renders every declared agent into the runtime bundle", () => {
  const root = mkdtempSync(join(tmpdir(), "openclaw-context-render-"));
  try {
    mkdirSync(join(root, "config"), {recursive: true});
    mkdirSync(join(root, "instructions", "agents"), {recursive: true});
    mkdirSync(join(root, "instructions", "agent-overlays"), {recursive: true});
    writeFileSync(join(root, "config", "instance.json"), JSON.stringify({agents: ["liv", "max"], paths: {runtimeRoot: "/runtime", dataRoot: "/data"}}));
    writeFileSync(join(root, "instructions", "AGENTS.md"), "Framework");
    writeFileSync(join(root, "instructions", "AGENTS-instance.md"), "Instance");
    mkdirSync(join(root, "instructions", "docs"), {recursive: true});
    writeFileSync(join(root, "instructions", "docs", "reply-shape.md"), "Canonical envelope");
    writeFileSync(join(root, "instructions", "agents", "liv.md"), "---\nname: liv\n---\nLiv");
    writeFileSync(join(root, "instructions", "agents", "max.md"), "---\nname: max\n---\nMax");
    writeFileSync(join(root, "instructions", "agent-overlays", "max.md"), "Overlay");
    renderRuntimeContexts(root);
    for (const agent of ["liv", "max"]) {
      assert.match(readFileSync(join(root, "instructions", "openclaw", agent, "AGENTS.md"), "utf8"), /Canonical envelope/);
    }
    assert.match(readFileSync(join(root, "instructions", "openclaw", "max", "SOUL.md"), "utf8"), /Overlay/);
    assert.match(readFileSync(join(root, "instructions", "openclaw", "max", "MEMORY.md"), "utf8"), /data-plane bridge/);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
