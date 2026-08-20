import test from "node:test";
import assert from "node:assert/strict";

import {applyRuntimeProfiles} from "./render-openclaw-runtime-profiles.mjs";

const source = {
  agents: {
    list: [
      {id: "liv", workspace: "/data/liv", model: {primary: "openai/old", fallbacks: ["local/fallback"]}},
      {id: "max", workspace: "/data/max", model: {primary: "openai/old"}},
    ],
  },
};

const catalog = {
  defaultProfile: "native",
  agents: {
    liv: {defaultProfile: "cursor", allowedProfiles: ["native", "cursor"]},
    max: {defaultProfile: "native", allowedProfiles: ["native", "cursor"]},
  },
  profiles: {
    native: {runtime: "native", harness: "openclaw", model: "openai/gpt-5.6-sol"},
    cursor: {runtime: "acp", harness: "cursor", model: "cursor-grok-4.6-high", workspace: "required"},
  },
};

test("renders each agent's selected profile into effective OpenClaw config", () => {
  const rendered = applyRuntimeProfiles(source, catalog);
  assert.deepEqual(rendered.agents.list[0].runtime, {
    type: "acp",
    acp: {agent: "cursor", backend: "acpx", mode: "persistent", cwd: "/data/liv"},
  });
  assert.deepEqual(rendered.agents.list[1].runtime, {type: "embedded"});
  assert.equal(rendered.agents.list[1].model.primary, "openai/gpt-5.6-sol");
  assert.equal(rendered.agents.list[0].model.primary, "openai/old");
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
