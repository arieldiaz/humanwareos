#!/usr/bin/env node

import {readFileSync, realpathSync, writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {applyRuntimeProfiles, canonicalRuntimeRoot, loadJson5} from "./render-openclaw-runtime-profiles.mjs";

function fail(message) {
  throw new Error(`openclaw-config: ${message}`);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

export function applySlackChannel(sourceConfig, channelConfig, manifest) {
  const source = structuredClone(object(sourceConfig, "source config"));
  const channel = object(channelConfig, "Slack channel config");
  if (channel.id !== "slack" || channel.adapter !== "slack") fail("channel config must describe Slack");
  source.channels ??= {};
  source.channels.slack ??= {};
  source.channels.slack.enabled = channel.enabled === true;
  if (!source.channels.slack.enabled) return source;

  const provider = String(manifest?.secrets?.openclawProvider ?? "").trim();
  if (!provider || !source?.secrets?.providers?.[provider]) fail("enabled Slack requires secrets.openclawProvider in the manifest and source config");
  const configured = object(channel.accounts, "Slack accounts");
  const sourceAccounts = object(source.channels.slack.accounts, "source Slack accounts");
  const sharedPolicy = {};
  for (const key of ["allowFrom", "dmPolicy", "groupPolicy"]) {
    if (source.channels.slack[key] !== undefined) sharedPolicy[key] = source.channels.slack[key];
    delete source.channels.slack[key];
  }
  const accounts = {};
  const bindings = [];
  for (const [id, account] of Object.entries(configured)) {
    const target = structuredClone(object(sourceAccounts[id], `source Slack account ${id}`));
    for (const [key, value] of Object.entries(sharedPolicy)) target[key] ??= structuredClone(value);
    const bot = object(account.botToken, `Slack account ${id} bot token`);
    const app = object(account.appToken, `Slack account ${id} app token`);
    if (!bot.id || !app.id) fail(`Slack account ${id} token references require ids`);
    target.botToken = {source: "exec", provider, id: bot.id};
    target.appToken = {source: "exec", provider, id: app.id};
    accounts[id] = target;
    bindings.push({type: "route", agentId: id, match: {channel: "slack", accountId: id}});
  }
  source.channels.slack.accounts = accounts;
  source.bindings = bindings;
  return source;
}

export function renderOpenClawConfig({source, profiles, slack, manifest, runtimeRoot}) {
  const configured = applySlackChannel(source, slack, manifest);
  const rendered = applyRuntimeProfiles(configured, profiles);
  let serialized = JSON.stringify(rendered, null, 2);
  if (serialized.includes("__HUMANWARE_RUNTIME_ROOT__")) {
    if (!runtimeRoot) fail("source config requires a runtime root");
    serialized = serialized.replaceAll("__HUMANWARE_RUNTIME_ROOT__", JSON.stringify(canonicalRuntimeRoot(runtimeRoot)).slice(1, -1));
  }
  return `${serialized}\n`;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [sourcePath, profilesPath, slackPath, manifestPath, outputPath, runtimeRoot] = process.argv.slice(2);
  if (!sourcePath || !profilesPath || !slackPath || !manifestPath || !outputPath || !runtimeRoot) {
    console.error("Usage: render-openclaw-config.mjs SOURCE PROFILES SLACK MANIFEST OUTPUT RUNTIME_ROOT");
    process.exit(2);
  }
  try {
    const rendered = renderOpenClawConfig({
      source: loadJson5(sourcePath),
      profiles: JSON.parse(readFileSync(profilesPath, "utf8")),
      slack: JSON.parse(readFileSync(slackPath, "utf8")),
      manifest: JSON.parse(readFileSync(manifestPath, "utf8")),
      runtimeRoot,
    });
    writeFileSync(outputPath, rendered, {mode: 0o600});
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
