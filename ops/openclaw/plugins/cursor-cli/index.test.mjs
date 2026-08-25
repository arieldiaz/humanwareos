import test from "node:test";
import assert from "node:assert/strict";
import {buildCursorCliBackends} from "./index.js";

test("registers parallel ask and workspace backends against the secret-safe wrapper", () => {
  const backends = buildCursorCliBackends("/runtime/cursor-agent-launch.sh");
  assert.deepEqual(backends.map((entry) => entry.id), ["cursor-ask", "cursor-agent"]);
  assert.equal(backends[0].config.command, "/runtime/cursor-agent-launch.sh");
  assert.equal(backends[0].config.jsonlDialect, "claude-stream-json");
  assert.equal(backends[0].config.serialize, false);
  assert.deepEqual(backends[0].config.sessionIdFields, ["session_id"]);
  assert.ok(backends[0].config.args.includes("ask"));
  assert.ok(backends[1].config.args.includes("--auto-review"));
  assert.ok(backends[1].config.args.includes("enabled"));
});
