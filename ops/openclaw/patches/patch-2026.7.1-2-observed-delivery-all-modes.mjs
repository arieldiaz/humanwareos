import fs from "node:fs";
import path from "node:path";

// The agent runner only reports a committed message-tool send to the dispatch
// layer (onObservedReplyDelivery) when the session runs in message_tool_only
// delivery mode. In automatic mode the send still reaches the user, but the
// dispatcher never learns about it — so a healthy turn that replies via the
// message tool and ends with empty final text (the mandated agent behavior in
// this instance) counts as "no visible dispatch": the gateway logs the
// zero-payload WARN and the heartbeat's silent-kill scan raises a false
// dropped-reply alert (2026-07-25: three false alerts for Max's #heirlooming
// turns whose replies had all landed).
//
// committedMessagingToolSourceReplyDelivery is computed mode-independently
// from delivery evidence; only this notification call gates on the mode.
// Report it in every mode. Downstream effects are all corrections:
// hasVisibleChannelTurnDispatch turns true (WARN correctly suppressed),
// noVisibleReplyFallbackEligible stays false (a reply was committed), and the
// message_tool_only text fallback patch stays inert on such turns.

const distDir = "/opt/homebrew/lib/node_modules/openclaw/dist";
const candidates = fs
  .readdirSync(distDir)
  .filter((name) => /^agent-runner\.runtime-.*\.js$/.test(name))
  .map((name) => path.join(distDir, name));

const before = `\t\tif (opts?.sourceReplyDeliveryMode === "message_tool_only" && committedMessagingToolSourceReplyDelivery) await opts.onObservedReplyDelivery?.();`;

const after = `\t\tif (committedMessagingToolSourceReplyDelivery) await opts.onObservedReplyDelivery?.();`;

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
    "No matching OpenClaw agent-runner bundle found; the installed version changed and must be reviewed.",
  );
}

console.log(JSON.stringify({ patched, alreadyPatched, candidates: candidates.length }));
