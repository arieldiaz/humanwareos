import assert from "node:assert/strict";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {acquireLock, gradeEnvelope, parseGatewayHealth} from "./eval.mjs";

test("grades observable response state rather than exact wording", () => {
  assert.equal(gradeEnvelope("A concise result.", {shape: "short", status: "done"}).pass, true);
  assert.equal(gradeEnvelope("A concise handoff.\n\n## ✋ Act\nComplete identity verification.", {shape: "short", status: "act"}).pass, true);
  assert.equal(gradeEnvelope("## TLDR\nDone.\n\n## ✋ Act\nComplete identity verification.", {shape: "substantive", status: "act"}).pass, true);
  assert.equal(gradeEnvelope("## TLDR\nDone.\n\n## ❓ Clarify\nWhich target?\n\n## Next Step\nWait.", {shape: "substantive", status: "act"}).pass, false);
});

test("rejects the overlapping protocols this change retires", () => {
  for (const response of ["Goal: fix it", "## Status\nNo action needed.", "Agent — working: checking"] ) {
    assert.equal(gradeEnvelope(response, {shape: "short", status: "done"}).pass, false);
  }
});

test("requires a healthy non-degraded gateway before a live case", () => {
  assert.deepEqual(parseGatewayHealth('{"ok":true,"eventLoop":{"degraded":false}}'), {ready: true, reason: "ready"});
  assert.deepEqual(parseGatewayHealth('{"ok":true,"eventLoop":{"degraded":true,"reasons":["event_loop_delay"]}}'), {ready: false, reason: "gateway event loop degraded: event_loop_delay"});
  assert.equal(parseGatewayHealth("not json").ready, false);
});

test("serializes live eval processes and recovers a stale lock", () => {
  const directory = mkdtempSync(join(tmpdir(), "response-envelope-eval-"));
  const lock = join(directory, "runner.lock");
  try {
    const release = acquireLock(lock);
    assert.throws(() => acquireLock(lock), /already running/);
    release();
    writeFileSync(lock, "999999999\n");
    acquireLock(lock)();
  } finally {
    rmSync(directory, {recursive: true});
  }
});
