import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";


export function defaultConversationFencePath(env = process.env) {
  const stateRoot = env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw");
  return join(stateRoot, "run-signature", "conversation-fences.json");
}

function normalizeChannel(value) {
  const channel = String(value ?? "").replace(/^channel:/i, "").toUpperCase();
  return /^[CDG][A-Z0-9]+$/.test(channel) ? channel : undefined;
}

function normalizeThread(value) {
  const thread = String(value ?? "").trim();
  return /^\d{10}\.\d{6}$/.test(thread) ? thread : undefined;
}

export function conversationFenceRoute({ channel, threadId, sessionKey, origin } = {}) {
  const sessionMatch = String(sessionKey ?? "").match(/:slack:channel:([^:]+):thread:([^:]+)$/i);
  const resolvedChannel = normalizeChannel(channel ?? origin?.nativeChannelId ?? origin?.channelId ?? origin?.to ?? sessionMatch?.[1]);
  const resolvedThread = normalizeThread(threadId ?? origin?.threadId ?? origin?.replyToId ?? sessionMatch?.[2]);
  if (!resolvedChannel || !resolvedThread) return;
  return { channel: resolvedChannel, threadId: resolvedThread };
}

export function conversationFenceKey(route) {
  const resolved = conversationFenceRoute(route);
  return resolved ? `slack:${resolved.channel}:${resolved.threadId}` : undefined;
}

// Read-only legacy source. A first live mutation imports this boundary into
// FinalRuntime; B reconciles untouched history before removing this fallback.
export function readLegacyFence(route, {path = defaultConversationFencePath()} = {}) {
  try {
    const snapshot = JSON.parse(readFileSync(path, "utf8"));
    if (snapshot.schemaVersion !== 1 || !snapshot.conversations) throw new Error("Invalid legacy fence snapshot");
    return snapshot.conversations[conversationFenceKey(route)];
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}

export function readConversationFence(route, {path = join(dirname(defaultConversationFencePath()), "final-decisions.json"), legacyPath} = {}) {
  const key = conversationFenceKey(route);
  if (!key) return;
  let conversation;
  try { conversation = JSON.parse(readFileSync(path, "utf8")).conversations?.[key]; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (conversation?.generation !== undefined) {
    if (!Number.isInteger(conversation.generation) || conversation.generation < 0 || !['open', 'closing', 'closed'].includes(conversation.state)) throw new Error('Invalid lifecycle generation');
    return conversation;
  }
  const legacy = readLegacyFence(route, {path: legacyPath});
  if (legacy && (!['open', 'closing', 'closed'].includes(legacy.state) || (conversation?.status && (conversation.status === 'closed') !== (legacy.state === 'closed')))) return {...legacy, reconciliationRequired: true};
  return legacy ?? (conversation?.status === "closed" ? {state: "closed", reconciliationRequired: true} : undefined);
}

export function shouldSuppressConversationDelivery(route, {workCreatedAt, ...paths} = {}) {
  const fence = readConversationFence(route, paths);
  if (!fence) return false;
  if (fence.reconciliationRequired || fence.state === "closing" || fence.state === "closed") return true;
  // Missing origin time after a historical fence cannot prove eligibility.
  return Number.isFinite(fence.closedThrough) && (!Number.isFinite(workCreatedAt) || workCreatedAt <= fence.closedThrough);
}

export function isHumanSlackUserProfile(user) {
  return Boolean(user?.id && user.deleted !== true && user.is_bot !== true && user.is_app_user !== true);
}
