import fs from "node:fs";
import path from "node:path";

const packageRoot = process.env.OPENCLAW_PACKAGE_ROOT || "/opt/homebrew/lib/node_modules/openclaw";
const distDir = process.env.OPENCLAW_CORE_DIST || path.join(packageRoot, "dist");

function bundles(pattern) {
  return fs.readdirSync(distDir).filter((name) => pattern.test(name)).map((name) => path.join(distDir, name));
}

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) throw new Error(`Expected one ${label} site in the reviewed OpenClaw 2026.9.1 bundle.`);
  return source.replace(before, after);
}

function removeOnce(source, before, alreadyMarker, label) {
  if (!source.includes(before) && source.includes(alreadyMarker)) return source;
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) throw new Error(`Expected one ${label} site in the reviewed OpenClaw 2026.9.1 bundle.`);
  return source.replace(before, "");
}

let patched = 0;
let alreadyPatched = 0;
const spawnBundles = bundles(/^sessions-spawn-tool-.*\.js$/);
for (const file of spawnBundles) {
  const original = fs.readFileSync(file, "utf8");
  let source = original;
  source = replaceOnce(
    source,
    "const group = readToolStringParam(params.raw, \"group\");",
    "const group = readToolStringParam(params.raw, \"group\");\n\tconst thinkingOverride = readToolStringParam(params.raw, \"thinking\");",
    "visible thinking read",
  );
  source = removeOnce(
    source,
    `\t\t[\n\t\t\t"thinking",\n\t\t\treadToolStringParam(params.raw, "thinking"),\n\t\t\t"thinking overrides are not wired to the sessions.create path"\n\t\t],\n`,
    "thinkingLevel: thinkingOverride",
    "visible thinking rejection",
  );
  source = replaceOnce(
    source,
    "\t\t\t\tmodel: resolvedModel,\n\t\t\t\ttask: params.task,",
    "\t\t\t\tmodel: resolvedModel,\n\t\t\t\t...thinkingOverride ? { thinkingLevel: thinkingOverride } : {},\n\t\t\t\ttask: params.task,",
    "sessions.create thinking input",
  );
  source = source
    .replace("omit mode, thread, thinking, lightContext, attachments", "omit mode, thread, lightContext, attachments")
    .replace("no thread/thinking/lightContext or attachment staging", "no thread/lightContext or attachment staging")
    .replace("Thinking override; unavailable with visible=true.", "Thinking override; visible sessions apply it before their initial run.");
  if (!source.includes("visible sessions apply it before their initial run") || !source.includes("thinkingLevel: thinkingOverride")) {
    throw new Error("The reviewed visible-session thinking markers were not produced.");
  }
  if (source === original) alreadyPatched += 1;
  else {
    fs.writeFileSync(file, source);
    patched += 1;
  }
}

const descriptionBundles = bundles(/^tool-description-presets-.*\.js$/);
for (const file of descriptionBundles) {
  const original = fs.readFileSync(file, "utf8");
  const source = original.replace(
    "`thread`, `thinking`, and `lightContext`",
    "`thread`, and `lightContext`; `thinking` is applied before the initial run",
  );
  if (!source.includes("`thinking` is applied before the initial run")) {
    throw new Error("The reviewed sessions_spawn description was not found.");
  }
  if (source === original) alreadyPatched += 1;
  else {
    fs.writeFileSync(file, source);
    patched += 1;
  }
}

if (!spawnBundles.length || !descriptionBundles.length || patched + alreadyPatched !== spawnBundles.length + descriptionBundles.length) {
  throw new Error("No complete OpenClaw 2026.9.1 visible-session bundle set was found; review the installed version.");
}

console.log(JSON.stringify({ patched, alreadyPatched, spawnBundles: spawnBundles.length, descriptionBundles: descriptionBundles.length }));
