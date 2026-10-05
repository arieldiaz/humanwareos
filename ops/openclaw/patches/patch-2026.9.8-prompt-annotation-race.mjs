import fs from "node:fs";
import path from "node:path";

const packageRoot = process.env.OPENCLAW_PACKAGE_ROOT || "/opt/homebrew/lib/node_modules/openclaw";
const distDir = process.env.OPENCLAW_CORE_DIST || path.join(packageRoot, "dist");
const marker = "humanware:additive-prompt-annotation-metadata";
const expectedVersion = "2026.9.8";
const installedVersion = JSON.parse(fs.readFileSync(path.join(distDir, "..", "package.json"), "utf8")).version;
if (installedVersion !== expectedVersion) throw new Error(`OpenClaw ${installedVersion} is not ${expectedVersion}; review the prompt annotation patch before applying.`);

const readableBefore = `\t\t\tif (!isDeepStrictEqual(current, admittedMessage)) throw new Error("native prompt annotation cannot replace an edited admission");
\t\t\tconst metadata = admittedMessage["__openclaw"] ?? {};`;
const readableAfter = `\t\t\t// ${marker}
\t\t\tconst { __openclaw: currentMetadata, ...currentBody } = current;
\t\t\tconst { __openclaw: admittedMetadata, ...admittedBody } = admittedMessage;
\t\t\tif (!isDeepStrictEqual(currentBody, admittedBody)) throw new Error("native prompt annotation cannot replace an edited admission");
\t\t\tconst metadata = currentMetadata ?? {};
\t\t\tif (Object.entries(admittedMetadata ?? {}).some(([key, value]) => !Object.hasOwn(metadata, key) || !isDeepStrictEqual(metadata[key], value))) throw new Error("native prompt annotation conflicts with recorded provenance");`;
const readableNextBefore = `\t\t\tconst next = {
\t\t\t\t...admittedMessage,
\t\t\t\t__openclaw: {`;
const readableNextAfter = `\t\t\tconst next = {
\t\t\t\t...current,
\t\t\t\t__openclaw: {`;

const annotationSignal = "native prompt annotation cannot replace an edited admission";
const candidates = fs.readdirSync(distDir).filter((name) => /^selection-.*\.mjs$/.test(name)).map((name) => path.join(distDir, name)).filter((file) => {
  const source = fs.readFileSync(file, "utf8");
  return source.includes(annotationSignal) || source.includes(marker);
});
let patched = 0;
let alreadyPatched = 0;
for (const file of candidates) {
  const source = fs.readFileSync(file, "utf8");
  if (source.includes(marker)) {
    alreadyPatched += 1;
    continue;
  }
  let updated = source;
  let complete = false;
  if (updated.includes(readableBefore) && updated.includes(readableNextBefore)) {
    updated = updated.replace(readableBefore, readableAfter).replace(readableNextBefore, readableNextAfter);
    complete = updated.includes(readableNextAfter);
  }
  if (!complete || updated === source || !updated.includes(marker)) continue;
  fs.writeFileSync(file, updated);
  patched += 1;
}
if (candidates.length === 0 || patched + alreadyPatched !== candidates.length) throw new Error("Not every OpenClaw prompt annotation bundle matched; the installed version changed and must be reviewed.");
console.log(JSON.stringify({patched, alreadyPatched, candidates: candidates.length}));
