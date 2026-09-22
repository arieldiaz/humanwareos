import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const SCHEMA_VERSION = 1;

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

function emptySnapshot() {
  return { schemaVersion: SCHEMA_VERSION, conversations: {} };
}

function normalizeSnapshot(value) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION || typeof value.conversations !== "object") return emptySnapshot();
  return { schemaVersion: SCHEMA_VERSION, conversations: { ...value.conversations } };
}

function readSnapshotSync(path) {
  try {
    return normalizeSnapshot(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return emptySnapshot();
    throw error;
  }
}

export function readConversationFence(route, { path = defaultConversationFencePath() } = {}) {
  const key = conversationFenceKey(route);
  return key ? readSnapshotSync(path).conversations[key] : undefined;
}

export function shouldSuppressConversationDelivery(route, { path = defaultConversationFencePath(), workCreatedAt } = {}) {
  const fence = readConversationFence(route, { path });
  if (!fence) return false;
  if (fence.state === "closing" || fence.state === "closed") return true;
  return fence.state === "open" && Number.isFinite(workCreatedAt) && Number.isFinite(fence.closedThrough) && workCreatedAt <= fence.closedThrough;
}

export function conversationContentHash(content) {
  return createHash("sha256").update(String(content ?? "")).digest("hex");
}

export function findDeliveredConversationClose(messages, fence, { botUserId } = {}) {
  const startedAt = Number(fence?.closeStartedAt);
  if (!Number.isFinite(startedAt) || !botUserId) return;
  return (messages ?? []).find((message) => {
    const deliveredAt = Number.parseFloat(String(message?.ts ?? "")) * 1000;
    if (!Number.isFinite(deliveredAt) || deliveredAt < startedAt || message?.user !== botUserId) return false;
    const text = String(message?.text ?? "");
    return (fence.closeContentHash && conversationContentHash(text) === fence.closeContentHash) || /(?:^|\n)## Session Closed(?:\n|$)/u.test(text);
  });
}

export function isHumanSlackUserProfile(user) {
  return Boolean(user?.id && user.deleted !== true && user.is_bot !== true && user.is_app_user !== true);
}

export class ConversationFenceStore {
  constructor({ path = defaultConversationFencePath(), now = () => Date.now(), uuid = randomUUID } = {}) {
    this.path = path;
    this.now = now;
    this.uuid = uuid;
    this.pending = Promise.resolve();
  }

  read(route) {
    return readConversationFence(route, { path: this.path });
  }

  shouldSuppress(route, options) {
    return shouldSuppressConversationDelivery(route, { path: this.path, ...options });
  }

  listClosing() {
    return Object.entries(readSnapshotSync(this.path).conversations)
      .filter(([, fence]) => fence?.state === "closing")
      .map(([key, fence]) => {
        const [, channel, threadId] = key.split(":");
        return { route: { channel, threadId }, fence };
      });
  }

  async mutate(route, operation) {
    const key = conversationFenceKey(route);
    if (!key) throw new Error("the canonical Slack conversation route is unavailable");
    const run = async () => {
      const snapshot = await this.#read();
      const current = snapshot.conversations[key];
      const result = operation(current);
      if (!result?.next || result.next === current) return result?.value;
      snapshot.conversations[key] = result.next;
      await this.#write(snapshot);
      return result.value;
    };
    const current = this.pending.catch(() => {}).then(run);
    this.pending = current;
    return current;
  }

  async ensureOpen(route) {
    return this.mutate(route, (current) => {
      if (current) return { next: current, value: current };
      const at = this.now();
      const next = { state: "open", revision: 1, openedAt: at, updatedAt: at };
      return { next, value: next };
    });
  }

  async reopenFromHuman(route, { messageId, receivedAt = this.now() } = {}) {
    return this.mutate(route, (current) => {
      if (!current) {
        const next = { state: "open", revision: 1, openedAt: receivedAt, updatedAt: receivedAt, reopenedByMessageId: messageId };
        return { next, value: { reopened: true, fence: next } };
      }
      if (current.state === "open") return { next: current, value: { reopened: false, fence: current } };
      const next = { ...current, state: "open", revision: current.revision + 1, updatedAt: receivedAt, reopenedAt: receivedAt, reopenedByMessageId: messageId, closeToken: undefined, closeStartedAt: undefined, closePreparedAt: undefined, closeContentHash: undefined, closeAccountId: undefined };
      return { next, value: { reopened: true, fence: next } };
    });
  }

  async beginClosing(route, { accountId } = {}) {
    return this.mutate(route, (current) => {
      if (current?.state === "closed") return { next: current, value: { accepted: false, reason: "already_closed", fence: current } };
      if (current?.state === "closing") return { next: current, value: { accepted: false, reason: "already_closing", fence: current } };
      const at = this.now();
      const token = this.uuid();
      const next = { ...current, state: "closing", revision: (current?.revision ?? 0) + 1, openedAt: current?.openedAt ?? at, updatedAt: at, closeStartedAt: at, closeToken: token, closeAccountId: accountId };
      return { next, value: { accepted: true, token, fence: next } };
    });
  }

  async armClose(route, token, { content, preparedAt = this.now() } = {}) {
    return this.mutate(route, (current) => {
      if (current?.state !== "closing" || current.closeToken !== token) return { next: current, value: { armed: false, fence: current } };
      const next = { ...current, updatedAt: preparedAt, closePreparedAt: preparedAt, closeContentHash: conversationContentHash(content) };
      return { next, value: { armed: true, fence: next } };
    });
  }

  async commitClose(route, token, { messageId, deliveredAt = this.now() } = {}) {
    return this.mutate(route, (current) => {
      if (current?.state !== "closing" || current.closeToken !== token) return { next: current, value: { committed: false, fence: current } };
      const next = { ...current, state: "closed", revision: current.revision + 1, updatedAt: deliveredAt, closedAt: deliveredAt, closedThrough: deliveredAt, closeMessageId: messageId, closeToken: undefined, closeStartedAt: undefined, closePreparedAt: undefined, closeContentHash: undefined, closeAccountId: undefined };
      return { next, value: { committed: true, fence: next } };
    });
  }

  async abortClose(route, token, { failedAt = this.now() } = {}) {
    return this.mutate(route, (current) => {
      if (current?.state !== "closing" || current.closeToken !== token) return { next: current, value: { aborted: false, fence: current } };
      const next = { ...current, state: "open", revision: current.revision + 1, updatedAt: failedAt, closeToken: undefined, closeStartedAt: undefined, closePreparedAt: undefined, closeContentHash: undefined, closeAccountId: undefined };
      return { next, value: { aborted: true, fence: next } };
    });
  }

  async #read() {
    try {
      return normalizeSnapshot(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") return emptySnapshot();
      throw error;
    }
  }

  async #write(snapshot) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${this.uuid()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }
}
