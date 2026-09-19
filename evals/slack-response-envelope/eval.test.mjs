import assert from "node:assert/strict";
import test from "node:test";
import {gradeEnvelope} from "./eval.mjs";

test("grades observable response state rather than exact wording", () => {
  assert.equal(gradeEnvelope("A concise result.", {shape: "short", status: "no_action"}).pass, true);
  assert.equal(gradeEnvelope("## TLDR\nDone.\n\n## ✋ Act\nComplete identity verification.", {shape: "substantive", status: "act"}).pass, true);
  assert.equal(gradeEnvelope("## TLDR\nDone.\n\n## ❓ Clarify\nWhich target?\n\n## Next Step\nWait.", {shape: "substantive", status: "answer"}).pass, false);
});

test("rejects the overlapping protocols this change retires", () => {
  for (const response of ["Goal: fix it", "## Status\nNo action needed.", "Agent — working: checking"] ) {
    assert.equal(gradeEnvelope(response, {shape: "short", status: "no_action"}).pass, false);
  }
});
