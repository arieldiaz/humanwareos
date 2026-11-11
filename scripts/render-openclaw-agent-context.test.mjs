import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {fileURLToPath} from "node:url";
import {excerpt, renderAgentContext, renderRuntimeContexts} from "./render-openclaw-agent-context.mjs";

const orchestrationSpec = readFileSync(fileURLToPath(new URL("../docs/orchestration.md", import.meta.url)), "utf8");
const orchestration = "# Spec\n\n## The ladder\n\nLowest rung.\n\n## Root agents\n\nRoot plans.\n\n## Workers\n\nOne brief.\n\n### Nested workers\n\nDepth one.\n\n## Routing\n\nData scope first.\n\n## Ledger\n\nRoot-only detail.\n";

test("renders framework, instance, identity, and data-plane references", () => {
  const rendered = renderAgentContext({
    agentId: "max",
    frameworkRules: "Framework rules.",
    instanceRules: "Owner: the human.",
    responseContract: "Use ## TLDR for substantive replies.",
    orchestration,
    agentTemplate: "---\nname: max\ndescription: CEO-minded operator\n---\n# Max",
    agentOverlay: "---\nname: Max\nemoji: fox_face\n---\nOwn the product.",
    runtimeCurrent: "/runtime/current",
    dataRoot: "/data",
  });
  assert.match(rendered["AGENTS.md"], /Framework rules/);
  assert.match(rendered["AGENTS.md"], /Owner: the human/);
  assert.match(rendered["AGENTS.md"], /## Reply shape[\s\S]*Use ## TLDR/);
  assert.match(rendered["SOUL.md"], /Own the product/);
  assert.match(rendered["SOUL.md"], /\/data\/current\/memory/);
  assert.doesNotMatch(rendered["SOUL.md"], /Before every Slack reply, read/);
  assert.match(rendered["IDENTITY.md"], /Name: Max/);
  assert.match(rendered["IDENTITY.md"], /Emoji: fox_face/);
  assert.match(rendered["MEMORY.md"], /\/data\/current\/memory/);
  assert.match(rendered["STRATEGY.md"], /\/data\/current\/strategy\/current\.md/);
  assert.match(rendered["AGENTS.md"], /## Worker contract[\s\S]*### Workers\n\nOne brief[\s\S]*#### Nested workers\n\nDepth one[\s\S]*## Private instance context/);
  assert.doesNotMatch(rendered["AGENTS.md"], /Root plans|Lowest rung/);
  assert.match(rendered["SOUL.md"], /## Orchestration\n\n### The ladder\n\nLowest rung[\s\S]*### Root agents[\s\S]*### Routing\n\nData scope first/);
  assert.doesNotMatch(rendered["SOUL.md"], /One brief|Root-only detail/);
});

test("the orchestration spec keeps every section the live prompt copies", () => {
  for (const title of ["The ladder", "Root agents", "Workers", "Routing"]) assert.match(excerpt(orchestrationSpec, [title]), new RegExp(`^### ${title}\n`));
  assert.match(excerpt(orchestrationSpec, ["Workers"]), /#### Nested workers/);
  assert.throws(() => excerpt(orchestrationSpec, ["Missing"]), /spec section Missing is missing/);
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
    writeFileSync(join(root, "instructions", "docs", "orchestration.md"), orchestration);
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
