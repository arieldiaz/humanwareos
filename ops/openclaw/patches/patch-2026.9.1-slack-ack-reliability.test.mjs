import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const patchPath = fileURLToPath(new URL("./patch-2026.9.1-slack-ack-reliability.mjs", import.meta.url));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-slack-ack-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({version: "2026.9.1"}));
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, "pipeline.runtime-fixture.js"), `function decision({statusReactionsExplicitlyEnabled, effectiveWasMentioned, shouldBypassMention, sourceRepliesAreToolOnly, isRoomEvent, shouldAckReaction$1}) {\n\tconst allowToolOnlyStatusReaction = statusReactionsExplicitlyEnabled && (effectiveWasMentioned || shouldBypassMention);\n\tconst shouldSendAckReaction = shouldAckReaction$1() && (!sourceRepliesAreToolOnly || allowToolOnlyStatusReaction || isRoomEvent);\n\treturn shouldSendAckReaction;\n}\nfunction reaction(reactSlackMessage, message, ackReactionMessageTs, ackReactionValue, ctx, slackClient, statusReactionsWillHandle, formatSlackError) {\n\tconst ackReactionPromise = true ? reactSlackMessage(message.channel, ackReactionMessageTs, ackReactionValue, {\n\t\ttoken: ctx.botToken,\n\t\tclient: slackClient\n\t}).then(() => true, (err) => {\n\t\tlogVerbose(\`slack react failed for channel \${message.channel}: \${formatSlackError(err)}\`);\n\t\treturn false;\n\t}) : statusReactionsWillHandle ? Promise.resolve(true) : null;\n}`);
  return {root, dist};
}

function apply(root) {
  execFileSync(process.execPath, [patchPath], {env: {...process.env, OPENCLAW_SLACK_PLUGIN_ROOT: root}, stdio: "pipe"});
}

test("explicit mentions receive acknowledgement reactions in tool-only delivery mode", (t) => {
  const {root, dist} = fixture(t);
  apply(root);
  const source = fs.readFileSync(path.join(dist, "pipeline.runtime-fixture.js"), "utf8");
  const decision = Function(`${source}; return decision;`)();
  assert.equal(decision({statusReactionsExplicitlyEnabled: false, effectiveWasMentioned: true, shouldBypassMention: false, sourceRepliesAreToolOnly: true, isRoomEvent: false, shouldAckReaction$1: () => true}), true);
  assert.equal(decision({statusReactionsExplicitlyEnabled: false, effectiveWasMentioned: false, shouldBypassMention: false, sourceRepliesAreToolOnly: true, isRoomEvent: false, shouldAckReaction$1: () => true}), false);
  assert.match(source, /slack acknowledgement reaction failed/);
  assert.doesNotMatch(source, /logVerbose\(`slack react failed/);
});

test("Slack acknowledgement patch is idempotent", (t) => {
  const {root, dist} = fixture(t);
  apply(root);
  const file = path.join(dist, "pipeline.runtime-fixture.js");
  const before = fs.readFileSync(file, "utf8");
  apply(root);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});
