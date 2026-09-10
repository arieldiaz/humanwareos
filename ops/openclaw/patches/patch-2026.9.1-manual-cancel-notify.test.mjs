import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const patchPath = fileURLToPath(new URL("./patch-2026.9.1-manual-cancel-notify.mjs", import.meta.url));
const fixture = `function maybeNotifyOnExit(session, status) {
  if (!session.backgrounded || !session.notifyOnExit || session.exitNotified || session.terminalPollObserved) return;
  const output = session.output || "";
  if (status === "failed" && session.exitReason === "manual-cancel" && !output) return;
  if (status === "completed" && session.exitCode === 0 && !output && session.notifyOnExitEmptySuccess !== true) return;
  return "notify";
}`;

function patchFixture(source = fixture) {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-manual-cancel-patch-"));
  const bundle = path.join(distDir, "bash-tools.exec-runtime-fixture.js");
  fs.writeFileSync(bundle, source);
  execFileSync(process.execPath, [patchPath], {
    env: { ...process.env, OPENCLAW_CORE_DIST: distDir },
    stdio: "pipe",
  });
  return fs.readFileSync(bundle, "utf8");
}

function loadMaybeNotifyOnExit(source) {
  return Function(`${source}\nreturn maybeNotifyOnExit;`)();
}

test("intentional cancellation never enqueues an exit notification", () => {
  const maybeNotifyOnExit = loadMaybeNotifyOnExit(patchFixture());
  const base = { backgrounded: true, notifyOnExit: true };
  assert.equal(maybeNotifyOnExit({ ...base, exitReason: "manual-cancel", output: "partial output" }, "failed"), undefined);
  assert.equal(maybeNotifyOnExit({ ...base, exitReason: "manual-cancel", output: "" }, "failed"), undefined);
});

test("unexpected failures still enqueue an exit notification", () => {
  const maybeNotifyOnExit = loadMaybeNotifyOnExit(patchFixture());
  assert.equal(maybeNotifyOnExit({ backgrounded: true, notifyOnExit: true, exitReason: "signal", output: "partial output" }, "failed"), "notify");
});

test("patch is idempotent", () => {
  const once = patchFixture();
  assert.equal(patchFixture(once), once);
});
