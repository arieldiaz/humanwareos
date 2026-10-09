import test from "node:test";
import assert from "node:assert/strict";
import {realpathSync} from "node:fs";
import {tmpdir} from "node:os";
import {loadJson5} from "./render-openclaw-runtime-profiles.mjs";
import {bindSecretsProvider, configBasePath, mergeConfig, renderOpenClawConfig} from "./render-openclaw-config.mjs";

const base = loadJson5(configBasePath);
const runtimeRoot = realpathSync(tmpdir());

const source = {
  secrets: {providers: {private_secrets: {source: "exec"}}},
  agents: {
    defaults: {},
    entries: {liv: {workspace: "/data/liv"}, max: {workspace: "/data/max"}},
  },
  channels: {slack: {
    allowFrom: ["owner"],
    dmPolicy: "allowlist",
    groupPolicy: "open",
    accounts: {liv: {}, max: {groupPolicy: "allowlist"}, default: {}},
  }},
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
  assert.deepEqual(Object.keys(rendered.channels.slack.accounts), ["liv", "max"]);
  assert.deepEqual(rendered.channels.slack.accounts.liv.allowFrom, ["owner"]);
  assert.equal(rendered.channels.slack.accounts.liv.dmPolicy, "allowlist");
  assert.equal(rendered.channels.slack.accounts.max.groupPolicy, "allowlist");
  assert.equal(rendered.channels.slack.allowFrom, undefined);
  assert.deepEqual(rendered.bindings, [
    {type: "route", agentId: "liv", match: {channel: "slack", accountId: "liv"}},
    {type: "route", agentId: "max", match: {channel: "slack", accountId: "max"}},
  ]);
  assert.equal(rendered.agents.entries.max.model.primary, "openai/model");
});

test("merges the instance overlay over the framework base as a JSON merge patch", () => {
  const overlay = structuredClone(source);
  overlay.secrets.providers.private_secrets.env = {HOME: "/Users/me", HUMANWARE_DOPPLER_ENV_FILE: "/Users/me/.config/doppler.env"};
  overlay.gateway = {port: 18789, nodes: {commands: {deny: ["sms.send"]}}};
  overlay.memory = null;
  overlay.plugins = {allow: ["slack"], entries: {codex: {config: {appServer: {command: "/opt/homebrew/bin/codex"}}}}};
  const rendered = JSON.parse(renderOpenClawConfig({
    base,
    source: overlay,
    profiles,
    slack,
    manifest: {secrets: {openclawProvider: "private_secrets"}},
    runtimeRoot,
  }));
  const provider = rendered.secrets.providers.private_secrets;
  assert.equal(provider.command, `${runtimeRoot}/framework/ops/openclaw/runtime/secret-exec.sh`);
  assert.equal(provider.jsonOnly, true);
  assert.deepEqual(provider.env, {PATH: base.secrets.providers.__HUMANWARE_SECRETS_PROVIDER__.env.PATH, HOME: "/Users/me", HUMANWARE_DOPPLER_ENV_FILE: "/Users/me/.config/doppler.env"});
  assert.equal(rendered.secrets.providers.__HUMANWARE_SECRETS_PROVIDER__, undefined);
  assert.equal(rendered.gateway.port, 18789);
  assert.equal(rendered.gateway.bind, "loopback");
  assert.deepEqual(rendered.gateway.nodes.commands.deny, ["sms.send"]);
  assert.equal(rendered.memory, undefined);
  assert.equal(rendered.agents.defaults.compaction.mode, "safeguard");
  assert.deepEqual(rendered.plugins.allow, ["slack"]);
  assert.deepEqual(rendered.plugins.entries.codex, {enabled: true, config: {appServer: {command: "/opt/homebrew/bin/codex"}}});
  assert.equal(rendered.plugins.entries["cursor-cli"].config.command, `${runtimeRoot}/framework/ops/openclaw/runtime/cursor-agent-launch.sh`);
  assert.deepEqual(mergeConfig({a: {b: [1], c: 1}}, {a: {b: [2], d: 2}}), {a: {b: [2], c: 1, d: 2}});
});

test("drops the secrets provider template when the manifest names no OpenClaw provider", () => {
  const bound = bindSecretsProvider(base, {secrets: {provider: "doppler", bootstrap: "external"}});
  assert.equal(bound.secrets, undefined);
  const rendered = JSON.parse(renderOpenClawConfig({
    base,
    source: {agents: {entries: {liv: {}, max: {}}}, channels: {slack: {enabled: false}}},
    profiles,
    slack: {id: "slack", adapter: "slack", enabled: false},
    manifest: {secrets: {provider: "doppler", bootstrap: "external"}},
    runtimeRoot,
  }));
  assert.equal(rendered.secrets, undefined);
  assert.equal(rendered.channels.slack.enabled, false);
  assert.equal(rendered.gateway.mode, "local");
});
