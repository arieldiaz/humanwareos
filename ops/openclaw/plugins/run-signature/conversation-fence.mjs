import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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

// A version marker is required even for an empty installation: absent historical
// rows cannot prove that there were no legacy-only boundaries before cutover.
export function assertLifecycleJournal(journal) {
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  if (journal?.lifecycleSchemaVersion !== 1 || !object(journal.conversations) || !object(journal.turns))
    throw new Error('Lifecycle migration/reconciliation required before runtime admission');
}

export function readConversationFence(route, {path = join(process.env.OPENCLAW_STATE_DIR || join(homedir(), '.openclaw'), 'run-signature', 'final-decisions.json')} = {}) {
  const key = conversationFenceKey(route);
  if (!key) return;
  const journal = JSON.parse(readFileSync(path, 'utf8'));
  assertLifecycleJournal(journal);
  const conversation = journal.conversations[key];
  if (conversation !== undefined && (!Number.isSafeInteger(conversation?.generation) || conversation.generation < 0 || !['open', 'closing', 'closed'].includes(conversation.state)))
    throw new Error('Invalid lifecycle generation; migration/reconciliation required');
  return conversation;
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
