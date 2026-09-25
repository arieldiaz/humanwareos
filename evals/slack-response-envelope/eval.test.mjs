import assert from "node:assert/strict";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {acquireLock, gradeEnvelope, parseGatewayHealth} from "./eval.mjs";

test("grades the explicit field and never headings", () => {
  const wire = (status, message) => JSON.stringify({schemaVersion: 1, status, message});
  assert.equal(gradeEnvelope(wire('act', '## Session Closed'), {status: 'act'}).pass, true);
  assert.equal(gradeEnvelope(wire('closed', 'Closed.'), {status: 'closed'}).pass, true);
  assert.equal(gradeEnvelope(wire('act', 'Scheduled.'), {status: 'scheduled'}).pass, false);
  assert.equal(gradeEnvelope('Plain final', {status: 'act'}).pass, false);
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
