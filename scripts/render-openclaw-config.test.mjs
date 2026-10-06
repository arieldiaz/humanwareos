import test from "node:test";
import assert from "node:assert/strict";
import {renderOpenClawConfig} from "./render-openclaw-config.mjs";

const source = {
  secrets: {providers: {private_secrets: {source: "exec"}}},
  agents: {
    defaults: {},
    entries: {liv: {workspace: "/data/liv"}, max: {workspace: "/data/max"}},
  },
  channels: {slack: {accounts: {liv: {}, max: {}}}},
};
const profiles = {
  profiles: {native: {runtime: "native", model: "openai/model", reasoning: "low"}},
  agents: {
    liv: {defaultProfile: "native", allowedProfiles: ["native"]},
    max: {defaultProfile: "native", allowedProfiles: ["native"]},
  },
};
const slack = {
  id: "slack",
  adapter: "slack",
  enabled: true,
  accounts: {
    liv: {botToken: {id: "liv/BOT"}, appToken: {id: "liv/APP"}},
    max: {botToken: {id: "max/BOT"}, appToken: {id: "max/APP"}},
  },
};

test("renders Slack references and routing from the instance declarations", () => {
  const rendered = JSON.parse(renderOpenClawConfig({
    source,
    profiles,
    slack,
    manifest: {secrets: {openclawProvider: "private_secrets"}},
    runtimeRoot: "/runtime/build",
  }));
  assert.deepEqual(rendered.channels.slack.accounts.liv.botToken, {source: "exec", provider: "private_secrets", id: "liv/BOT"});
  assert.deepEqual(rendered.bindings, [
    {type: "route", agentId: "liv", match: {channel: "slack", accountId: "liv"}},
    {type: "route", agentId: "max", match: {channel: "slack", accountId: "max"}},
  ]);
  assert.equal(rendered.agents.entries.max.model.primary, "openai/model");
});
