import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const patchPath = fileURLToPath(new URL("./patch-2026.9.1-visible-session-thinking.mjs", import.meta.url));
const spawnFixture = `const VISIBLE_SESSIONS_SPAWN_SCHEMA = {
\tvisible: Type.Optional(Type.Boolean({ description: "Durable visible session: coding/multi-step/keepable results; works without UI; subagent only. Default run mode and empty attachment fields are accepted; no thread/thinking/lightContext or attachment staging." }))
};
async function maybeSpawnVisibleSession(params) {
\tconst group = readToolStringParam(params.raw, "group");
\tif (params.raw.visible !== true) throw new ToolInputError("For a visible session, use visible=true with runtime=\\"subagent\\"; omit mode, thread, thinking, lightContext, attachments");
\tconst unsupportedEntries = [
\t\t[
\t\t\t"thinking",
\t\t\treadToolStringParam(params.raw, "thinking"),
\t\t\t"thinking overrides are not wired to the sessions.create path"
\t\t],
\t];
\tresponse = await createGatewayCall("sessions.create", {
\t\t\t\tmodel: resolvedModel,
\t\t\t\ttask: params.task,
\t});
}
thinking: Type.Optional(Type.String({ description: "Thinking override; unavailable with visible=true." }));`;
const descriptionFixture = 'Subagent only; omit `mode` (`mode="run"` is also accepted), `thread`, `thinking`, and `lightContext`; other text.';

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-visible-thinking-"));
  fs.writeFileSync(path.join(root, "sessions-spawn-tool-fixture.js"), spawnFixture);
  fs.writeFileSync(path.join(root, "tool-description-presets-fixture.js"), descriptionFixture);
  return root;
}

function apply(root) {
  return execFileSync(process.execPath, [patchPath], { env: { ...process.env, OPENCLAW_CORE_DIST: root }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

test("passes visible thinking into sessions.create before the initial run", () => {
  const root = makeFixture();
  apply(root);
  const source = fs.readFileSync(path.join(root, "sessions-spawn-tool-fixture.js"), "utf8");
  assert.match(source, /const thinkingOverride = readToolStringParam\(params\.raw, "thinking"\)/);
  assert.match(source, /thinkingLevel: thinkingOverride/);
  assert.doesNotMatch(source, /thinking overrides are not wired/);
  assert.match(source, /visible sessions apply it before their initial run/);
  assert.match(fs.readFileSync(path.join(root, "tool-description-presets-fixture.js"), "utf8"), /`thinking` is applied before the initial run/);
});

test("patch is idempotent", () => {
  const root = makeFixture();
  apply(root);
  const first = fs.readFileSync(path.join(root, "sessions-spawn-tool-fixture.js"), "utf8");
  apply(root);
  assert.equal(fs.readFileSync(path.join(root, "sessions-spawn-tool-fixture.js"), "utf8"), first);
});

test("fails closed when the reviewed bundle shape changes", () => {
  const root = makeFixture();
  fs.writeFileSync(path.join(root, "sessions-spawn-tool-fixture.js"), "changed upstream");
  assert.throws(() => apply(root));
});
