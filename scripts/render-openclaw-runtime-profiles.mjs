#!/usr/bin/env node

import {readFileSync, realpathSync, writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";

function fail(message) {
  throw new Error(`runtime-profiles: ${message}`);
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

export function applyRuntimeProfiles(sourceConfig, catalog) {
  const source = structuredClone(requireObject(sourceConfig, "source config"));
  const profiles = requireObject(catalog?.profiles, "profiles");
  const agentPolicies = requireObject(catalog?.agents, "agents");
  const agents = source?.agents?.list;
  if (!Array.isArray(agents) || agents.length === 0) fail("source config agents.list must be a non-empty array");

  source.agents.list = agents.map((agent) => {
    const id = String(agent?.id ?? "").trim();
    if (!id) fail("every source agent must have an id");
    const policy = requireObject(agentPolicies[id], `agent policy ${id}`);
    const profileId = String(policy.defaultProfile ?? catalog.defaultProfile ?? "").trim();
    if (!profileId) fail(`agent ${id} has no selected profile`);
    if (!Array.isArray(policy.allowedProfiles) || !policy.allowedProfiles.includes(profileId)) {
      fail(`agent ${id} cannot select profile ${profileId}`);
    }
    const profile = requireObject(profiles[profileId], `profile ${profileId}`);
    if (profile.enabled === false) fail(`agent ${id} selected disabled profile ${profileId}`);

    if (profile.runtime === "native") {
      const model = String(profile.model ?? "").trim();
      if (!model.includes("/")) fail(`native profile ${profileId} must use a provider/model reference`);
      const priorModel = agent.model && typeof agent.model === "object" && !Array.isArray(agent.model) ? agent.model : {};
      return {
        ...agent,
        model: {...priorModel, primary: model},
        runtime: {type: "embedded"},
      };
    }

    if (profile.runtime === "acp") {
      const harness = String(profile.harness ?? "").trim();
      if (!harness) fail(`ACP profile ${profileId} must name a harness`);
      const cwd = String(agent.workspace ?? "").trim();
      if (profile.workspace === "required" && !cwd) fail(`ACP profile ${profileId} requires a workspace for agent ${id}`);
      return {
        ...agent,
        runtime: {
          type: "acp",
          acp: {
            agent: harness,
            backend: String(profile.backend ?? "acpx"),
            mode: String(profile.mode ?? "persistent"),
            ...(cwd ? {cwd} : {}),
          },
        },
      };
    }

    fail(`profile ${profileId} has unsupported runtime ${String(profile.runtime)}`);
  });

  return source;
}

function loadJson5(path) {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    const require = createRequire(import.meta.url);
    let JSON5;
    try {
      JSON5 = require("/opt/homebrew/lib/node_modules/openclaw/node_modules/json5");
    } catch {
      JSON5 = require("json5");
    }
    return JSON5.parse(text);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [sourcePath, profilesPath, outputPath] = process.argv.slice(2);
  if (!sourcePath || !profilesPath || !outputPath) {
    console.error("Usage: render-openclaw-runtime-profiles.mjs SOURCE PROFILES OUTPUT");
    process.exit(2);
  }
  try {
    const rendered = applyRuntimeProfiles(loadJson5(sourcePath), JSON.parse(readFileSync(profilesPath, "utf8")));
    writeFileSync(outputPath, `${JSON.stringify(rendered, null, 2)}\n`, {mode: 0o600});
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
