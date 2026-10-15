import fs from "node:fs";
import path from "node:path";
import {resolveSlackPluginDist} from "./slack-plugin-root.mjs";

// Stock Slack reaction notifications are rendered as prose system events. A
// prose string cannot authenticate the actor or preserve the structured Slack
// event needed by the human-status projector. Offer the unmodified event to a
// same-process bridge first; when it claims the event, do not enqueue prose or
// wake a model. Nonclaimed reactions retain stock behavior.

const bundles = path.join(resolveSlackPluginDist(), ".setup");
const matches = fs.readdirSync(bundles).filter((name) => /^monitor-.*\.mjs$/.test(name));
if (matches.length !== 1) throw new Error(`Expected one Slack monitor bundle, found ${matches.length}`);
const file = path.join(bundles, matches[0]);
let source = fs.readFileSync(file, "utf8");

const before = `\t\t\tconst item = event.item;\n\t\t\tif (!item || item.type !== "message") return;\n\t\t\tif (runtimeContext.reactionMode === "off") return;`;
const after = `\t\t\tconst item = event.item;\n\t\t\tif (!item || item.type !== "message") return;\n\t\t\tconst humanStatusBridge = globalThis[Symbol.for("humanware.slackReactionEvent")];\n\t\t\tif (typeof humanStatusBridge === "function" && await humanStatusBridge({ event, action, eventScope, eventId })) {\n\t\t\t\ttrackEvent?.();\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tif (runtimeContext.reactionMode === "off") return;`;

if (source.includes(after)) {
  console.log(JSON.stringify({slackHumanStatusEvents: "already patched"}));
} else {
  const occurrences = source.split(before).length - 1;
  if (occurrences !== 1) throw new Error(`Expected one structured reaction-event anchor, found ${occurrences}`);
  source = source.replace(before, after);
  fs.writeFileSync(file, source);
  console.log(JSON.stringify({slackHumanStatusEvents: "patched"}));
}
