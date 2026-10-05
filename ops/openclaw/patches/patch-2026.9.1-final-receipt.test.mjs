import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const patch = fileURLToPath(new URL("./patch-2026.9.1-final-receipt.mjs", import.meta.url));
const source = fs.readFileSync(patch, "utf8");
// Collect the reviewed edits without filesystem I/O; the fixture exercises shape checking only.
const edits = [];
vm.runInNewContext(source.slice(source.indexOf("const delivery ="), source.indexOf("// Validate every anchor")), { edit: (file, before, after) => edits.push({ file, before, after }) });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "final-receipt-patch-"));
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.9.1" }));
  for (const file of new Set(edits.map((edit) => edit.file))) fs.writeFileSync(path.join(root, "dist", file), edits.filter((edit) => edit.file === file).map((edit) => edit.before).join("\n"));
  return root;
}
function apply(root) {
  return execFileSync(process.execPath, [patch], { env: { ...process.env, OPENCLAW_PACKAGE_ROOT: root, OPENCLAW_CORE_DIST: path.join(root, "dist") }, encoding: "utf8", stdio: "pipe" });
}
const read = (root) => fs.readdirSync(path.join(root, "dist")).map((file) => fs.readFileSync(path.join(root, "dist", file), "utf8"));

test("patch checks every shape and is idempotent", () => {
  const root = fixture();
  try {
    apply(root);
    const snapshot = read(root);
    apply(root);
    assert.deepEqual(read(root), snapshot);
    assert.equal(snapshot.some((text) => text.includes("planSlackChannelThread")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("unsupported version, changed anchor or retired root edits fail before mutation", () => {
  for (const change of ["version", "anchor", "retired"]) {
    const root = fixture();
    try {
      if (change === "version") fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.9.2" }));
      if (change === "anchor") fs.writeFileSync(path.join(root, "dist/send-BcPUy9RI.js"), "unreviewed");
      if (change === "retired") fs.writeFileSync(path.join(root, "dist/humanware-slack-channel-thread.mjs"), "");
      const before = read(root);
      assert.throws(() => apply(root), change === "retired" ? /reinstall openclaw@2026\.9\.1/ : undefined);
      assert.deepEqual(read(root), before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
