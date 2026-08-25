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

function profileDefaults(profile) {
  return {
    ...(profile.reasoning ? {thinkingDefault: String(profile.reasoning)} : {}),
    ...(profile.fastMode !== undefined ? {fastModeDefault: profile.fastMode} : {}),
  };
}

function setHarnessModel(source, harness, model, selectedHarnessModels) {
  const prior = selectedHarnessModels.get(harness);
  if (prior && prior !== model) fail(`ACP harness ${harness} selected with conflicting models ${prior} and ${model}`);
  selectedHarnessModels.set(harness, model);
  const agent = source?.plugins?.entries?.acpx?.config?.agents?.[harness];
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) fail(`ACP harness ${harness} is not configured in plugins.entries.acpx.config.agents`);
  const args = Array.isArray(agent.args) ? [...agent.args] : [];
  const modelIndex = args.indexOf("--model");
  if (modelIndex >= 0) {
    if (modelIndex + 1 >= args.length) fail(`ACP harness ${harness} has --model without a value`);
    args[modelIndex + 1] = model;
  } else {
    args.unshift("--model", model);
  }
  agent.args = args;
}

function runtimeId(profile) {
  if (profile.runtime === "native") return "openclaw";
  if (profile.runtime === "cli") return String(profile.backend ?? profile.harness ?? "").trim();
  if (profile.runtime === "app-server") return String(profile.backend ?? profile.harness ?? "").trim();
  return "";
}

export function applyRuntimeProfiles(sourceConfig, catalog) {
  const source = structuredClone(requireObject(sourceConfig, "source config"));
  const profiles = requireObject(catalog?.profiles, "profiles");
  const agentPolicies = requireObject(catalog?.agents, "agents");
  const agents = source?.agents?.list;
  if (!Array.isArray(agents) || agents.length === 0) fail("source config agents.list must be a non-empty array");
  const selectedHarnessModels = new Map();

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
    const escalationProfileId = String(policy.escalationProfile ?? "").trim();
    if (escalationProfileId) {
      if (!policy.allowedProfiles.includes(escalationProfileId)) fail(`agent ${id} cannot escalate to profile ${escalationProfileId}`);
      const escalationProfile = requireObject(profiles[escalationProfileId], `profile ${escalationProfileId}`);
      if (escalationProfile.enabled === false) fail(`agent ${id} escalation profile ${escalationProfileId} is disabled`);
    }
    const defaults = profileDefaults(profile);
    const modelPolicies = agent.models && typeof agent.models === "object" && !Array.isArray(agent.models)
      ? structuredClone(agent.models)
      : {};
    for (const allowedProfileId of policy.allowedProfiles) {
      const allowedProfile = requireObject(profiles[allowedProfileId], `profile ${allowedProfileId}`);
      if (allowedProfile.enabled === false) continue;
      const model = String(allowedProfile.model ?? "").trim();
      if (!model.includes("/")) fail(`profile ${allowedProfileId} must use a provider/model reference`);
      const selectedRuntime = runtimeId(allowedProfile);
      if (!selectedRuntime && allowedProfile.runtime !== "acp") fail(`profile ${allowedProfileId} has no registered runtime id`);
      if (selectedRuntime) {
        const prior = modelPolicies[model] ?? {};
        const priorRuntime = prior?.agentRuntime?.id;
        if (priorRuntime && priorRuntime !== selectedRuntime) {
          fail(`model ${model} maps to conflicting runtimes ${priorRuntime} and ${selectedRuntime}`);
        }
        modelPolicies[model] = {...prior, agentRuntime: {id: selectedRuntime}};
      }
    }

    if (["native", "cli", "app-server"].includes(profile.runtime)) {
      const model = String(profile.model ?? "").trim();
      if (!model.includes("/")) fail(`profile ${profileId} must use a provider/model reference`);
      const priorModel = agent.model && typeof agent.model === "object" && !Array.isArray(agent.model) ? agent.model : {};
      return {
        ...agent,
        model: {...priorModel, primary: model},
        models: modelPolicies,
        ...defaults,
        runtime: {type: "embedded"},
      };
    }

    if (profile.runtime === "acp") {
      const harness = String(profile.harness ?? "").trim();
      if (!harness) fail(`ACP profile ${profileId} must name a harness`);
      const cwd = String(agent.workspace ?? "").trim();
      if (profile.workspace === "required" && !cwd) fail(`ACP profile ${profileId} requires a workspace for agent ${id}`);
      const model = String(profile.model ?? "").trim();
      if (!model) fail(`ACP profile ${profileId} must name a model`);
      setHarnessModel(source, harness, model, selectedHarnessModels);
      return {
        ...agent,
        models: modelPolicies,
        ...defaults,
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

  const sourceBindings = Array.isArray(source.bindings) ? source.bindings : [];
  for (const binding of sourceBindings) {
    if (binding?.type === "acp" && binding?.match?.peer?.id === "*") fail("wildcard ACP bindings are prohibited; select ACP explicitly through the broker");
  }
  source.bindings = sourceBindings;

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
