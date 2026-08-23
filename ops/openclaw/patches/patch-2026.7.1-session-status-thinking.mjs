import fs from "node:fs";
import path from "node:path";

// OpenClaw 2026.7.1 exposes model overrides through session_status but leaves
// the already-supported session thinkingLevel inaccessible to the tool. Add a
// sibling `thinking` argument so an agent can switch model + reasoning in one
// control call. The patch is version-scoped, idempotent, and fails closed.

const packageRoot = process.env.OPENCLAW_PACKAGE_ROOT ?? "/opt/homebrew/lib/node_modules/openclaw";
const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
if (!String(packageJson.version).startsWith("2026.7.1")) {
  throw new Error(`Expected OpenClaw 2026.7.1, found ${packageJson.version}.`);
}

const dist = path.join(packageRoot, "dist");
const findOne = (pattern, marker, label) => {
  const matches = fs.readdirSync(dist)
    .filter((name) => pattern.test(name))
    .map((name) => path.join(dist, name))
    .filter((file) => fs.readFileSync(file, "utf8").includes(marker));
  if (matches.length !== 1) throw new Error(`Expected one ${label} bundle, found ${matches.length}.`);
  return matches[0];
};

const toolsFile = findOne(/^openclaw-tools-.*\.js$/, "const SessionStatusToolSchema", "session-status tool");
let tools = fs.readFileSync(toolsFile, "utf8");
const alreadyPatched = tools.includes("thinking: Type.Optional(Type.String())") && tools.includes("changedThinking");

if (!alreadyPatched) {
  const replacements = [
    [
      "\tsessionKey: Type.Optional(Type.String()),\n\tmodel: Type.Optional(Type.String())\n});",
      "\tsessionKey: Type.Optional(Type.String()),\n\tmodel: Type.Optional(Type.String()),\n\tthinking: Type.Optional(Type.String())\n});",
    ],
    [
      "\t\t\tconst modelRaw = readStringParam(params, \"model\");\n\t\t\tlet changedModel = false;",
      "\t\t\tconst modelRaw = readStringParam(params, \"model\");\n\t\t\tconst thinkingRaw = readStringParam(params, \"thinking\");\n\t\t\tconst normalizedThinking = thinkingRaw?.trim().toLowerCase();\n\t\t\tconst allowedThinking = new Set([\"default\", \"off\", \"minimal\", \"low\", \"medium\", \"high\", \"xhigh\", \"max\", \"auto\"]);\n\t\t\tif (normalizedThinking && !allowedThinking.has(normalizedThinking)) throw new Error(`Unrecognized thinking level \"${thinkingRaw}\".`);\n\t\t\tlet changedModel = false;\n\t\t\tlet changedThinking = false;",
    ],
    [
      "\t\t\tconst activeModelId = opts?.activeModelId?.trim();",
      "\t\t\tif (thinkingRaw !== void 0) {\n\t\t\t\tconst nextThinking = !normalizedThinking || normalizedThinking === \"default\" ? void 0 : normalizedThinking;\n\t\t\t\tif (resolved.entry.thinkingLevel !== nextThinking) {\n\t\t\t\t\tconst patchResult = await patchSessionEntryWithKey({\n\t\t\t\t\t\tagentId,\n\t\t\t\t\t\tsessionKey: resolved.key,\n\t\t\t\t\t\tstorePath\n\t\t\t\t\t}, (entry, context) => {\n\t\t\t\t\t\tconst persistedEntryPatch = { ...entry };\n\t\t\t\t\t\tif (nextThinking === void 0) delete persistedEntryPatch.thinkingLevel;\n\t\t\t\t\t\telse persistedEntryPatch.thinkingLevel = nextThinking;\n\t\t\t\t\t\tif (!persistedEntryPatch.sessionId.trim() && !context.existingEntry?.sessionId?.trim()) persistedEntryPatch.sessionId = randomUUID();\n\t\t\t\t\t\treturn persistedEntryPatch;\n\t\t\t\t\t}, {\n\t\t\t\t\t\tfallbackEntry: resolved.persisted ? void 0 : resolved.entry,\n\t\t\t\t\t\treplaceEntry: true\n\t\t\t\t\t});\n\t\t\t\t\tif (!patchResult) throw new Error(`Unknown sessionKey: ${resolved.key}`);\n\t\t\t\t\tresolved = { entry: patchResult.entry, key: patchResult.sessionKey, persisted: true };\n\t\t\t\t\ttriggerSessionPatchHook({\n\t\t\t\t\t\tcfg,\n\t\t\t\t\t\tsessionEntry: patchResult.entry,\n\t\t\t\t\t\tsessionKey: patchResult.sessionKey,\n\t\t\t\t\t\tpatch: { key: patchResult.sessionKey, thinkingLevel: nextThinking ?? null }\n\t\t\t\t\t});\n\t\t\t\t\tchangedThinking = true;\n\t\t\t\t}\n\t\t\t}\n\t\t\tconst activeModelId = opts?.activeModelId?.trim();",
    ],
    [
      "\t\t\t\t\tchangedModel,\n\t\t\t\t\t...modelRaw !== void 0 ? {",
      "\t\t\t\t\tchangedModel,\n\t\t\t\t\tchangedThinking,\n\t\t\t\t\t...thinkingRaw !== void 0 ? { thinkingLevel: resolved.entry.thinkingLevel ?? null } : {},\n\t\t\t\t\t...modelRaw !== void 0 ? {",
    ],
  ];
  for (const [before, after] of replacements) {
    const count = tools.split(before).length - 1;
    if (count !== 1) throw new Error(`Expected one session-status patch target, found ${count}.`);
    tools = tools.replace(before, after);
  }
  fs.writeFileSync(toolsFile, tools);
}

const catalogFile = findOne(/^tool-catalog-.*\.js$/, "function describeSessionStatusTool", "tool catalog");
let catalog = fs.readFileSync(catalogFile, "utf8");
const oldDescription = "`model` sets session override; `model=default` resets.";
const newDescription = "`model` and `thinking` set session overrides; either value `default` resets its override.";
if (catalog.includes(oldDescription)) {
  catalog = catalog.replace(oldDescription, newDescription);
  fs.writeFileSync(catalogFile, catalog);
} else if (!catalog.includes(newDescription)) {
  throw new Error("Session-status tool description has an unexpected shape.");
}

const mutationFile = findOne(/^tool-mutation-.*\.js$/, 'case "session_status"', "tool mutation policy");
let mutation = fs.readFileSync(mutationFile, "utf8");
const oldMutation = 'case "session_status": return typeof record?.model === "string" && record.model.trim().length > 0;';
const newMutation = 'case "session_status": return typeof record?.model === "string" && record.model.trim().length > 0 || typeof record?.thinking === "string" && record.thinking.trim().length > 0;';
if (mutation.includes(oldMutation)) {
  mutation = mutation.replace(oldMutation, newMutation);
  fs.writeFileSync(mutationFile, mutation);
} else if (!mutation.includes(newMutation)) {
  throw new Error("Session-status mutation policy has an unexpected shape.");
}

console.log(JSON.stringify({ sessionStatusThinking: alreadyPatched ? "already patched" : "patched" }));
