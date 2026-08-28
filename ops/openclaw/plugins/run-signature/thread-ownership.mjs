import {appendFile, mkdir, readFile} from "node:fs/promises";
import {dirname, join} from "node:path";
import {homedir} from "node:os";

export const DEFAULT_THREAD_OWNERS_PATH = join(
  homedir(),
  ".openclaw",
  "run-signature",
  "thread-owners.jsonl",
);

export function mentionedAgentAccounts(content, accounts = {}) {
  const byBotId = new Map(Object.entries(accounts).map(([accountId, botUserId]) => [String(botUserId).toUpperCase(), accountId]));
  const ordered = [];
  for (const match of String(content ?? "").matchAll(/<@([A-Z0-9]+)>/gi)) {
    const accountId = byBotId.get(match[1].toUpperCase());
    if (accountId && !ordered.includes(accountId)) ordered.push(accountId);
  }
  return ordered;
}

export function threadOwnerKey(event = {}, ctx = {}) {
  if (String(event.channel ?? ctx.channelId ?? "").toLowerCase() !== "slack" || !event.isGroup) return;
  const conversationId = String(event.conversationId ?? event.parentConversationId ?? ctx.conversationId ?? "").trim();
  const rootId = String(event.threadId ?? event.messageId ?? "").trim();
  if (!conversationId || !rootId) return;
  return `slack:${conversationId.toLowerCase()}:${rootId}`;
}

export function decideThreadOwner({accountId, currentOwner, mentionedAccounts}) {
  const mentioned = Array.isArray(mentionedAccounts) ? mentionedAccounts : [];
  if (mentioned.length > 0) {
    const nextOwner = mentioned[0];
    return {
      allow: mentioned.includes(accountId),
      nextOwner,
      reason: mentioned.includes(accountId) ? "explicit-agent-mention" : "different-agent-mentioned",
    };
  }
  if (!currentOwner) return {allow: false, reason: "thread-owner-not-established"};
  return {
    allow: currentOwner === accountId,
    nextOwner: currentOwner,
    reason: currentOwner === accountId ? "thread-owner" : "different-thread-owner",
  };
}

export function inferThreadOwnerFromMessages(messages, accounts = {}) {
  const byBotId = new Map(Object.entries(accounts).map(([accountId, botUserId]) => [String(botUserId).toUpperCase(), accountId]));
  for (const message of [...(messages ?? [])].reverse()) {
    const owner = byBotId.get(String(message?.user ?? "").toUpperCase());
    if (owner) return owner;
  }
}

export function createThreadOwnershipRuntime({accounts, path = DEFAULT_THREAD_OWNERS_PATH, resolveUnclaimedOwner} = {}) {
  const owners = new Map();
  let serial = Promise.resolve();
  const ready = (async () => {
    let source;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const line of source.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.key && event.owner) owners.set(event.key, event.owner);
      } catch {
        // A partial final line after a crash is ignored; prior claims remain valid.
      }
    }
  })();

  return {
    async claim(event, ctx = {}) {
      const run = async () => {
        await ready;
        const key = threadOwnerKey(event, ctx);
        const accountId = String(event.accountId ?? ctx.accountId ?? "").toLowerCase();
        if (!key || !accountId) return {handled: false, reason: "outside-thread-ownership-scope"};
        const mentioned = mentionedAgentAccounts(event.content ?? event.body, accounts);
        const storedOwner = owners.get(key);
        let currentOwner = storedOwner;
        if (!currentOwner && mentioned.length === 0 && typeof resolveUnclaimedOwner === "function") {
          currentOwner = await resolveUnclaimedOwner(event, ctx);
        }
        const decision = decideThreadOwner({accountId, currentOwner, mentionedAccounts: mentioned});
        if (decision.nextOwner && decision.nextOwner !== storedOwner) {
          owners.set(key, decision.nextOwner);
          await mkdir(dirname(path), {recursive: true});
          await appendFile(path, `${JSON.stringify({time: new Date().toISOString(), key, owner: decision.nextOwner, messageId: event.messageId})}\n`);
        }
        return {handled: !decision.allow, owner: decision.nextOwner ?? currentOwner, reason: decision.reason};
      };
      const result = serial.catch(() => {}).then(run);
      serial = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}
