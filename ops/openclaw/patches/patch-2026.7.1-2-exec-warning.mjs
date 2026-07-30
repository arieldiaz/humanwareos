import fs from "node:fs";
import path from "node:path";

const distDir = "/opt/homebrew/lib/node_modules/openclaw/dist";
const candidates = fs
  .readdirSync(distDir)
  .filter((name) => /^payloads-.*\.js$/.test(name))
  .map((name) => path.join(distDir, name));

const before = `\tif (params.lastToolError.mutatingAction ?? isLikelyMutatingToolName(params.lastToolError.toolName)) return {
\t\tshowWarning: !params.hasUserFacingErrorReply && !params.hasUserFacingFailureAcknowledgement,
\t\tincludeDetails
\t};
\tif (isExecLikeToolName(params.lastToolError.toolName) && !includeDetails) return {
\t\tshowWarning: false,
\t\tincludeDetails
\t};`;

const after = `\tif (isExecLikeToolName(params.lastToolError.toolName)) return {
\t\tshowWarning: !params.hasUserFacingReply,
\t\tincludeDetails
\t};
\tif (params.lastToolError.mutatingAction ?? isLikelyMutatingToolName(params.lastToolError.toolName)) return {
\t\tshowWarning: !params.hasUserFacingErrorReply && !params.hasUserFacingFailureAcknowledgement,
\t\tincludeDetails
\t};`;

let patched = 0;
let alreadyPatched = 0;
for (const file of candidates) {
  const source = fs.readFileSync(file, "utf8");
  if (source.includes(after)) {
    alreadyPatched += 1;
    continue;
  }
  if (!source.includes(before)) {
    continue;
  }
  fs.writeFileSync(file, source.replace(before, after));
  patched += 1;
}

if (patched === 0 && alreadyPatched === 0) {
  throw new Error(
    "No matching OpenClaw payload bundle found; the installed version changed and must be reviewed.",
  );
}

console.log(JSON.stringify({ patched, alreadyPatched, candidates: candidates.length }));
