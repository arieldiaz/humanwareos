import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const patchPath = fileURLToPath(new URL("./patch-2026.9.1-codex-runtime-reliability.mjs", import.meta.url));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-codex-reliability-"));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({version: "2026.9.1"}));
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, "transport-stdio-fixture.js"), `const MAX_PROCESS_CONTAINMENT_MS$1 = 2e3;\nconst MAX_PROCESS_CONTAINMENT_MS = 2e3;\nasync function reap(registration, deadline) { await readCodexAppServerProcessSnapshot(void 0, [registration.parent.pid, registration.child.pid]); }\nasync function register(child, spawned) { await readCodexAppServerProcessSnapshot(void 0, [child.pid]); await readCodexAppServerProcessCommand(spawned, Date.now() + 2e3); }`);
  return {root, dist};
}

function apply(root) {
  execFileSync(process.execPath, [patchPath], {env: {...process.env, OPENCLAW_CODEX_PLUGIN_ROOT: root}, stdio: "pipe"});
}

test("Codex process inspection shares the startup deadline and uses a ten-second containment budget", (t) => {
  const {root, dist} = fixture(t);
  apply(root);
  const source = fs.readFileSync(path.join(dist, "transport-stdio-fixture.js"), "utf8");
  assert.match(source, /MAX_PROCESS_CONTAINMENT_MS\$1 = 1e4/);
  assert.match(source, /MAX_PROCESS_CONTAINMENT_MS = 1e4/);
  assert.match(source, /readCodexAppServerProcessSnapshot\(deadline, \[registration\.parent\.pid/);
  assert.match(source, /readCodexAppServerProcessSnapshot\(Date\.now\(\) \+ MAX_PROCESS_CONTAINMENT_MS\$1, \[child\.pid\]\)/);
  assert.match(source, /readCodexAppServerProcessCommand\(spawned, Date\.now\(\) \+ MAX_PROCESS_CONTAINMENT_MS\$1\)/);
});

test("Codex runtime patch is idempotent", (t) => {
  const {root, dist} = fixture(t);
  apply(root);
  const file = path.join(dist, "transport-stdio-fixture.js");
  const before = fs.readFileSync(file, "utf8");
  apply(root);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});
