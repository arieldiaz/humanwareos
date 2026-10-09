import fs from "node:fs";
import path from "node:path";

import { resolveSlackPluginDist } from "./slack-plugin-root.mjs";

// Stock Slack 2026.9.8 calls this start callback on every typing keepalive,
// but guards the session-status API behind `didSetStatus`. Slack expires the
// status during long turns, so refresh it while work remains active. Keep the
// ordinary typing reaction single-shot.

const setupDir = path.join(resolveSlackPluginDist(), ".setup");
const candidates = fs.readdirSync(setupDir)
  .filter((name) => /^pipeline\.runtime-.*\.mjs$/.test(name))
  .map((name) => path.join(setupDir, name));

const before = `\t\t\tstart: async () => {
\t\t\t\tif (!didSetStatus && !threadStatusGate.hasVisibleOutput()) {
\t\t\t\t\tdidSetStatus = true;
\t\t\t\t\tstatusWasSet = await ctx.setSlackSessionStatus({
\t\t\t\t\t\tchannelId: message.channel,
\t\t\t\t\t\tthreadTs: statusThreadTs,
\t\t\t\t\t\tstatus: "processing",
\t\t\t\t\t\ttitle: prepared.sessionDisplayName ?? prepared.ctxPayload.ThreadLabel,
\t\t\t\t\t\teventScope: prepared.eventScope
\t\t\t\t\t});
\t\t\t\t}
\t\t\t\tif (typingReaction && message.ts) {`;

const after = `\t\t\tstart: async () => {
\t\t\t\t// humanware:slack-session-status-keepalive
\t\t\t\tif (!threadStatusGate.hasVisibleOutput()) {
\t\t\t\t\tconst refreshedStatus = await ctx.setSlackSessionStatus({
\t\t\t\t\t\tchannelId: message.channel,
\t\t\t\t\t\tthreadTs: statusThreadTs,
\t\t\t\t\t\tstatus: "processing",
\t\t\t\t\t\ttitle: prepared.sessionDisplayName ?? prepared.ctxPayload.ThreadLabel,
\t\t\t\t\t\teventScope: prepared.eventScope
\t\t\t\t\t});
\t\t\t\t\tdidSetStatus ||= refreshedStatus;
\t\t\t\t\tstatusWasSet ||= refreshedStatus;
\t\t\t\t}
\t\t\t\tif (!didAddTypingReaction && typingReaction && message.ts) {`;

let patched = 0;
let alreadyPatched = 0;
for (const file of candidates) {
  let source = fs.readFileSync(file, "utf8");
  if (!source.includes("ctx.setSlackSessionStatus")) continue;
  if (source.includes("humanware:slack-session-status-keepalive")) {
    alreadyPatched += 1;
    continue;
  }
  const matches = source.split(before).length - 1;
  if (matches !== 1) throw new Error(`Expected one Slack session-status start block in ${file}, found ${matches}.`);
  source = source.replace(before, after);
  fs.writeFileSync(file, source);
  patched += 1;
}

if (patched === 0 && alreadyPatched === 0) throw new Error("No Slack pipeline session-status block found; review the installed version.");
console.log(JSON.stringify({ patched, alreadyPatched }));
