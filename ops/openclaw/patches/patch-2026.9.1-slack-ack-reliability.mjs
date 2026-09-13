import fs from "node:fs";
import path from "node:path";
import {resolveSlackPluginDist} from "./slack-plugin-root.mjs";

const distDir = resolveSlackPluginDist();
const marker = "humanware:tool-only-explicit-mention-ack";
const before = `\tconst allowToolOnlyStatusReaction = statusReactionsExplicitlyEnabled && (effectiveWasMentioned || shouldBypassMention);
\tconst shouldSendAckReaction = shouldAckReaction$1() && (!sourceRepliesAreToolOnly || allowToolOnlyStatusReaction || isRoomEvent);`;
const after = `\t// ${marker}
\tconst allowToolOnlyAckReaction = effectiveWasMentioned || shouldBypassMention;
\tconst shouldSendAckReaction = shouldAckReaction$1() && (!sourceRepliesAreToolOnly || allowToolOnlyAckReaction || isRoomEvent);`;
const failureBefore = `\t}).then(() => true, (err) => {
\t\tlogVerbose(\`slack react failed for channel \${message.channel}: \${formatSlackError(err)}\`);
\t\treturn false;
\t}) : statusReactionsWillHandle ? Promise.resolve(true) : null;`;
const failureAfter = `\t}).then(() => true, (err) => {
\t\tctx.logger.warn({ channel: message.channel, messageTs: ackReactionMessageTs, emoji: ackReactionValue, error: formatSlackError(err) }, "slack acknowledgement reaction failed");
\t\treturn false;
\t}) : statusReactionsWillHandle ? Promise.resolve(true) : null;`;

const candidates = fs.readdirSync(distDir).filter((name) => /^pipeline\.runtime-.*\.js$/.test(name)).map((name) => path.join(distDir, name));
let patched = 0;
let alreadyPatched = 0;
for (const file of candidates) {
  const source = fs.readFileSync(file, "utf8");
  if (source.includes(marker)) {
    alreadyPatched += 1;
    continue;
  }
  if (!source.includes(before) || !source.includes(failureBefore)) continue;
  const updated = source.replace(before, after).replace(failureBefore, failureAfter);
  if (updated === source || !updated.includes(marker) || updated.includes(failureBefore)) continue;
  fs.writeFileSync(file, updated);
  patched += 1;
}
if (candidates.length === 0 || patched + alreadyPatched !== candidates.length) throw new Error("Not every OpenClaw Slack acknowledgement bundle matched; the installed version changed and must be reviewed.");
console.log(JSON.stringify({patched, alreadyPatched, candidates: candidates.length}));
