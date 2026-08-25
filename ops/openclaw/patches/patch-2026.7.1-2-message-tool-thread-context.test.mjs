import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const patchPath = fileURLToPath(new URL("./patch-2026.7.1-2-message-tool-thread-context.mjs", import.meta.url));

const unpatchedFixture = `function stringifyRouteThreadId(value) {
\treturn String(value);
}
function createMessageTool(options) {
\tconst effectiveCurrentChannel = { currentThreadTs: options?.effectiveCurrentThreadTs };
\tconst currentThreadTs = options?.currentThreadTs ?? (options?.agentThreadId != null ? stringifyRouteThreadId(options.agentThreadId) : effectiveCurrentChannel.currentThreadTs);
\treturn currentThreadTs;
}`;

function runPatch(source) {
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-message-thread-patch-"));
  const bundle = path.join(distDir, "openclaw-tools-fixture.js");
  fs.writeFileSync(bundle, source);
  execFileSync(process.execPath, [patchPath], {
    env: { ...process.env, OPENCLAW_DIST_DIR: distDir },
    stdio: "pipe",
  });
  return fs.readFileSync(bundle, "utf8");
}

function loadCreateMessageTool(source) {
  return Function(`${source}\nreturn createMessageTool;`)();
}

test("Slack thread session keys supply the missing message-tool thread context", () => {
  const patched = runPatch(unpatchedFixture);
  const createMessageTool = loadCreateMessageTool(patched);
  assert.equal(
    createMessageTool({ agentSessionKey: "agent:max:slack:channel:C0BJPDTAGEP:thread:1787655535.470449" }),
    "1787655535.470449",
  );
  assert.equal(
    createMessageTool({ agentSessionKey: "agent:liv:slack:group:G123:thread:1787656000.000001" }),
    "1787656000.000001",
  );
});

test("explicit thread context keeps precedence over the session-key fallback", () => {
  const createMessageTool = loadCreateMessageTool(runPatch(unpatchedFixture));
  const session = "agent:max:slack:channel:C123:thread:111.222";
  assert.equal(createMessageTool({ agentSessionKey: session, currentThreadTs: "333.444" }), "333.444");
  assert.equal(createMessageTool({ agentSessionKey: session, agentThreadId: "555.666" }), "555.666");
  assert.equal(createMessageTool({ agentSessionKey: session, effectiveCurrentThreadTs: "777.888" }), "777.888");
});

test("non-Slack and non-thread session keys do not invent thread context", () => {
  const createMessageTool = loadCreateMessageTool(runPatch(unpatchedFixture));
  assert.equal(createMessageTool({ agentSessionKey: "agent:max:discord:channel:C123:thread:111.222" }), undefined);
  assert.equal(createMessageTool({ agentSessionKey: "agent:max:slack:channel:C123" }), undefined);
});

test("patch is idempotent", () => {
  const once = runPatch(unpatchedFixture);
  const twice = runPatch(once);
  assert.equal(twice, once);
});
