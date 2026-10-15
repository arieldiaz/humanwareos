import {appendFile, mkdir} from "node:fs/promises";
import {createHash} from "node:crypto";
import {dirname, join} from "node:path";

export const SLACK_REACTION_EVENT_BRIDGE = Symbol.for("humanware.slackReactionEvent");

const CANONICAL_REACTIONS = new Set([
  "arrows_counterclockwise",
  "raised_hand",
  "hand",
  "calendar",
  "white_check_mark",
]);

export function normalizeHumanStatusEvent(payload, actorIds, observedAt = new Date().toISOString()) {
  const event = payload?.event;
  const action = payload?.action;
  if (!event || !["added", "removed"].includes(action)) return;
  if (event.item?.type !== "message" || !event.item.channel || !event.item.ts) return;
  if (!actorIds.has(event.user) || !CANONICAL_REACTIONS.has(event.reaction)) return;
  const logicalKey = [action, event.item.channel, event.item.ts, event.user, event.reaction, event.event_ts ?? ""].join(":");
  return {
    schemaVersion: 1,
    id: createHash("sha256").update(logicalKey).digest("hex"),
    eventId: payload.eventId ?? null,
    eventTs: event.event_ts ?? null,
    observedAt,
    action,
    actorId: event.user,
    reaction: event.reaction === "hand" ? "raised_hand" : event.reaction,
    channelId: event.item.channel,
    messageTs: event.item.ts,
    itemUserId: event.item_user ?? null,
    teamId: payload.eventScope?.teamId ?? null,
  };
}

export function installHumanStatusEventBridge({dataRoot, actorIds, append = appendFile, makeDirectory = mkdir}) {
  const allowed = new Set(actorIds ?? []);
  if (!dataRoot || allowed.size === 0) return () => {};
  const journal = join(dataRoot, "operations", "slack-notion-sync", "events.jsonl");
  const prior = globalThis[SLACK_REACTION_EVENT_BRIDGE];
  const handler = async (payload) => {
    const event = normalizeHumanStatusEvent(payload, allowed);
    if (!event) return false;
    await makeDirectory(dirname(journal), {recursive: true});
    await append(journal, `${JSON.stringify(event)}\n`, {mode: 0o600});
    return true;
  };
  globalThis[SLACK_REACTION_EVENT_BRIDGE] = handler;
  return () => {
    if (globalThis[SLACK_REACTION_EVENT_BRIDGE] === handler) {
      if (prior) globalThis[SLACK_REACTION_EVENT_BRIDGE] = prior;
      else delete globalThis[SLACK_REACTION_EVENT_BRIDGE];
    }
  };
}
