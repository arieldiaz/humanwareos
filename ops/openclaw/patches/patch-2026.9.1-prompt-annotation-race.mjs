import fs from "node:fs";
import path from "node:path";

const packageRoot = process.env.OPENCLAW_PACKAGE_ROOT || "/opt/homebrew/lib/node_modules/openclaw";
const distDir = process.env.OPENCLAW_CORE_DIST || path.join(packageRoot, "dist");
const marker = "humanware:additive-prompt-annotation-metadata";

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

const workerBefore = `if(assertCurrent(),!isDeepStrictEqual(Zt,Pn))throw Error(\`native prompt annotation cannot replace an edited admission\`);let _n=Pn.__openclaw??{};`;
const workerAfter = `assertCurrent();/* ${marker} */let{__openclaw:currentMetadata,...currentBody}=Zt,{__openclaw:admittedMetadata,...admittedBody}=Pn;if(!isDeepStrictEqual(currentBody,admittedBody))throw Error(\`native prompt annotation cannot replace an edited admission\`);let _n=currentMetadata??{};if(Object.entries(admittedMetadata??{}).some(([key,value])=>!Object.hasOwn(_n,key)||!isDeepStrictEqual(_n[key],value)))throw Error(\`native prompt annotation conflicts with recorded provenance\`);`;
const workerNextBefore = `let kn={...Pn,__openclaw:{..._n,...Dn}};`;
const workerNextAfter = `let kn={...Zt,__openclaw:{..._n,...Dn}};`;

const candidates = fs.readdirSync(distDir).filter((name) => /^user-turn-transcript-.*\.js$/.test(name)).map((name) => path.join(distDir, name));
const worker = path.join(distDir, "worker", "worker.mjs");
if (fs.existsSync(worker)) candidates.push(worker);
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
  } else if (updated.includes(workerBefore) && updated.includes(workerNextBefore)) {
    updated = updated.replace(workerBefore, workerAfter).replace(workerNextBefore, workerNextAfter);
    complete = updated.includes(workerNextAfter);
  }
  if (!complete || updated === source || !updated.includes(marker)) continue;
  fs.writeFileSync(file, updated);
  patched += 1;
}
if (candidates.length === 0 || patched + alreadyPatched !== candidates.length) throw new Error("Not every OpenClaw prompt annotation bundle matched; the installed version changed and must be reviewed.");
console.log(JSON.stringify({patched, alreadyPatched, candidates: candidates.length}));
