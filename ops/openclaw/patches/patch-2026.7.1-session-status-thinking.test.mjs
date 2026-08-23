import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const patchPath = fileURLToPath(new URL("./patch-2026.7.1-session-status-thinking.mjs", import.meta.url));

function fixture(version = "2026.7.1-2") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-thinking-"));
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));
  fs.writeFileSync(path.join(dist, "openclaw-tools-fixture.js"), `const SessionStatusToolSchema = Type.Object({
\tsessionKey: Type.Optional(Type.String()),
\tmodel: Type.Optional(Type.String())
});
async function execute(params) {
\t\t\tconst modelRaw = readStringParam(params, "model");
\t\t\tlet changedModel = false;
\t\t\tconst activeModelId = opts?.activeModelId?.trim();
\t\t\treturn {
\t\t\t\t\tdetails: {
\t\t\t\t\tchangedModel,
\t\t\t\t\t...modelRaw !== void 0 ? { model: resolved.entry.model ?? null } : {}
\t\t\t\t}
\t\t\t};
}
`);
  fs.writeFileSync(path.join(dist, "tool-catalog-fixture.js"), "function describeSessionStatusTool() { return `model` sets session override; `model=default` resets.; }\n");
  fs.writeFileSync(path.join(dist, "tool-mutation-fixture.js"), 'case "session_status": return typeof record?.model === "string" && record.model.trim().length > 0;\n');
  return { root, dist };
}

test("adds a native thinking override and is idempotent", () => {
  const { root, dist } = fixture();
  try {
    const env = { ...process.env, OPENCLAW_PACKAGE_ROOT: root };
    const first = JSON.parse(execFileSync(process.execPath, [patchPath], { env, encoding: "utf8" }));
    assert.equal(first.sessionStatusThinking, "patched");
    const tools = fs.readFileSync(path.join(dist, "openclaw-tools-fixture.js"), "utf8");
    assert.match(tools, /thinking: Type\.Optional/);
    assert.match(tools, /allowedThinking/);
    assert.match(tools, /thinkingLevel: nextThinking/);
    assert.match(tools, /changedThinking/);
    assert.match(fs.readFileSync(path.join(dist, "tool-catalog-fixture.js"), "utf8"), /`model` and `thinking` set session overrides/);
    assert.match(fs.readFileSync(path.join(dist, "tool-mutation-fixture.js"), "utf8"), /record\?\.thinking/);
    const second = JSON.parse(execFileSync(process.execPath, [patchPath], { env, encoding: "utf8" }));
    assert.equal(second.sessionStatusThinking, "already patched");
    assert.equal(fs.readFileSync(path.join(dist, "openclaw-tools-fixture.js"), "utf8"), tools);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed when the OpenClaw version changes", () => {
  const { root } = fixture("2026.8.0");
  try {
    assert.throws(() => execFileSync(process.execPath, [patchPath], {
      env: { ...process.env, OPENCLAW_PACKAGE_ROOT: root },
      stdio: "pipe",
    }), /Expected OpenClaw 2026\.7\.1/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
