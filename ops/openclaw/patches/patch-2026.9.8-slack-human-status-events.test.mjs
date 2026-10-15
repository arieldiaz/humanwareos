import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {spawnSync} from "node:child_process";

const patch = path.resolve("ops/openclaw/patches/patch-2026.9.8-slack-human-status-events.mjs");

test("patches the structured reaction handler once and is idempotent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "human-status-patch-"));
  const plugin = path.join(root, "plugin");
  const setup = path.join(plugin, "dist", ".setup");
  fs.mkdirSync(setup, {recursive: true});
  fs.writeFileSync(path.join(plugin, "package.json"), JSON.stringify({version: "2026.9.8"}));
  const anchor = '\t\t\tconst item = event.item;\n\t\t\tif (!item || item.type !== "message") return;\n\t\t\tif (runtimeContext.reactionMode === "off") return;';
  const monitor = path.join(setup, "monitor-fixture.mjs");
  fs.writeFileSync(monitor, anchor);
  const env = {...process.env, OPENCLAW_SLACK_PLUGIN_ROOT: plugin};
  const first = spawnSync(process.execPath, [patch], {env, encoding: "utf8"});
  assert.equal(first.status, 0, first.stderr);
  const source = fs.readFileSync(monitor, "utf8");
  assert.match(source, /humanware\.slackReactionEvent/);
  assert.match(source, /await humanStatusBridge\(\{ event, action, eventScope, eventId \}\)/);
  const second = spawnSync(process.execPath, [patch], {env, encoding: "utf8"});
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(monitor, "utf8"), source);
});
