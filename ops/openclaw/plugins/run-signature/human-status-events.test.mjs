import assert from "node:assert/strict";
import test from "node:test";
import {SLACK_REACTION_EVENT_BRIDGE, installHumanStatusEventBridge, normalizeHumanStatusEvent} from "./human-status-events.mjs";

const payload = {
  action: "added",
  eventId: "Ev1",
  eventScope: {teamId: "T1"},
  event: {
    user: "UOWNER",
    reaction: "hand",
    event_ts: "1792080000.000001",
    item_user: "UBOT",
    item: {type: "message", channel: "C1", ts: "1792070000.000001"},
  },
};

test("normalizes only canonical reactions from configured human actors", () => {
  const event = normalizeHumanStatusEvent(payload, new Set(["UOWNER"]), "2026-10-15T12:00:00Z");
  assert.equal(event.reaction, "raised_hand");
  assert.equal(event.channelId, "C1");
  assert.equal(event.messageTs, "1792070000.000001");
  assert.equal(event.eventTs, "1792080000.000001");
  assert.equal(normalizeHumanStatusEvent({...payload, event: {...payload.event, user: "UOTHER"}}, new Set(["UOWNER"])), undefined);
  assert.equal(normalizeHumanStatusEvent({...payload, event: {...payload.event, reaction: "eyes"}}, new Set(["UOWNER"])), undefined);
  assert.equal(normalizeHumanStatusEvent({...payload, event: {...payload.event, item: {type: "file"}}}, new Set(["UOWNER"])), undefined);
});

test("the bridge claims accepted events and appends structured JSON", async () => {
  const writes = [];
  const cleanup = installHumanStatusEventBridge({
    dataRoot: "/data",
    actorIds: ["UOWNER"],
    makeDirectory: async () => {},
    append: async (...args) => writes.push(args),
  });
  try {
    assert.equal(await globalThis[SLACK_REACTION_EVENT_BRIDGE](payload), true);
    assert.equal(await globalThis[SLACK_REACTION_EVENT_BRIDGE]({...payload, event: {...payload.event, reaction: "eyes"}}), false);
    assert.equal(writes.length, 1);
    assert.equal(JSON.parse(writes[0][1]).actorId, "UOWNER");
    assert.match(writes[0][0], /operations\/slack-notion-sync\/events\.jsonl$/);
  } finally {
    cleanup();
  }
});
