import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import {
  STRIP_NAME_SET,
  normalizeReactions,
  resolveModelTile,
  resolveHarnessTile,
  resolveThinkingTile,
  normalizeThinkingLevel,
  normalizeOutboundStatus,
  resolveStatusTile,
  planStatusTile,
} from "./strip-core.mjs";
import { createThreadOwnershipRuntime, inferThreadOwnerFromMessages } from "./thread-ownership.mjs";
import {
  closeSummary,
  formatCloseOut,
  loadThreadUsage,
  measureSlackThread,
  recordSessionClose,
} from "./session-close.mjs";

export {
  normalizeReactions,
  resolveModelTile,
  resolveHarnessTile,
  resolveThinkingTile,
  normalizeThinkingLevel,
  normalizeOutboundStatus,
  renderStatusFooter,
  resolveStatusTile,
  planStatusTile,
  tileKind,
} from "./strip-core.mjs";

// Faults go to a machine-readable journal, not just a human-readable log line.
// ops/openclaw/tools/error-digest.mjs reads this; a cron reads the digest. The
// journal and the digest are the whole monitoring path: strip problems are
// cosmetic and never earn a post in the thread they happened in.
const HOME = homedir();
const FAULT_JOURNAL = `${HOME}/.openclaw/run-signature/faults.jsonl`;
const DATA_ROOT = process.env.HUMANWARE_DATA_ROOT || `${HOME}/humanware-data`;
const OUTBOUND_EMOJI = {
  answer: "question",
  act: "raised_hand",
  working: "arrows_counterclockwise",
  scheduled: "calendar",
  closed: "white_check_mark",
};

async function recordOutboundStatus({ channel, threadId, status, agent, traceId, sessionKey, runId }) {
  if (!channel || !threadId || !status) return;
  const ts = new Date().toISOString();
  const event = {
    schemaVersion: 2,
    id: `status:${channel}:${threadId}:${ts}`,
    traceId: traceId ?? `status:${channel}:${threadId}`,
    ts,
    logicalSessionId: `slack:${channel}:${threadId}`,
    runtimeSessionId: null,
    agent: agent ?? null,
    source: "openclaw",
    kind: "status.set",
    level: "normal",
    summary: `Status ${status}`,
    details: { channelId: channel, threadId, status, emoji: OUTBOUND_EMOJI[status] },
    sourceRef: {sessionKey: sessionKey ?? null, runId: runId ?? null},
  };
  const path = `${DATA_ROOT}/evidence/sessions/events/${ts.slice(0, 10)}.jsonl`;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

async function appendFaultJournal(entry) {
  try {
    await mkdir(dirname(FAULT_JOURNAL), { recursive: true });
    await appendFile(FAULT_JOURNAL, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // The journal is diagnostics. It must never affect delivery.
  }
}

const SLACK_PROJECTS_DIR = `${HOME}/.openclaw/npm/projects`;

// The gateway's Slack package lives under a generation-hashed directory and its
// dist chunks are content-hashed; both change on every OpenClaw update. A
// hardcoded path then fails inside the hook's catch: replies keep flowing,
// strips silently stop, and only the journal knows. Resolve both hashes at use.
export function resolveSlackRuntimeModule(kind, { projectsDir = SLACK_PROJECTS_DIR, list = readdirSync, stat = statSync } = {}) {
  const projects = list(projectsDir)
    .filter((name) => name.startsWith("openclaw-slack-"))
    .map((name) => ({ name, mtime: stat(`${projectsDir}/${name}`)?.mtimeMs ?? 0 }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!projects.length) throw new Error(`no openclaw-slack package under ${projectsDir}`);
  const dist = `${projectsDir}/${projects[0].name}/node_modules/@openclaw/slack/dist`;
  const chunk = list(dist).find((name) => name.startsWith(`${kind}.runtime-`) && name.endsWith(".js"));
  if (!chunk) throw new Error(`no ${kind} runtime chunk in ${dist}`);
  return `${dist}/${chunk}`;
}

// The gateway's events disagree about what they carry: model_call_started may
// hold the thinking level but llm_output never does, while llm_output is the
// only one with harnessId. Overwriting per event meant the last event erased
// what an earlier one knew. A field the new event does not carry keeps its
// last-known value; model and provider always follow the newest event so a
// model switch is never masked.
export function mergeProvenance(prior, next) {
  return {
    model: next.model ?? prior?.model,
    provider: next.provider ?? prior?.provider,
    harnessId: next.harnessId ?? prior?.harnessId,
    sessionKey: next.sessionKey ?? prior?.sessionKey,
    thinkLevel: next.thinkLevel ?? prior?.thinkLevel,
    reasoningLevel: next.reasoningLevel ?? prior?.reasoningLevel,
    reasoningEffort: next.reasoningEffort ?? prior?.reasoningEffort,
  };
}

export function recoverMissingHarness(live, recovered) {
  if (!live || resolveHarnessTile(live) || !resolveHarnessTile(recovered)) return live;
  return mergeProvenance(recovered, live);
}

export function buildRunSignature(provenance) {
  return buildRunReactionNames(provenance).map((name) => `:${name}:`).join(" ");
}

export function buildRunReactionNames(provenance) {
  const tiles = [
    resolveModelTile(provenance.model),
    resolveHarnessTile(provenance),
    resolveThinkingTile(provenance),
  ].filter(Boolean);
  return tiles.map((tile) => tile.replaceAll(":", ""));
}

export async function addReactionsInOrder(names, add) {
  for (const name of names) await add(name);
}

export function createKeyedSerialQueue() {
  const pending = new Map();
  return async (key, task) => {
    const previous = pending.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    pending.set(key, current);
    try {
      return await current;
    } finally {
      if (pending.get(key) === current) pending.delete(key);
    }
  };
}

export function createToolFailureDeduper({ now = () => Date.now(), retentionMs = 300_000 } = {}) {
  const answeredRuns = new Map();
  const prune = (current) => {
    for (const [runId, answeredAt] of answeredRuns) {
      if (current - answeredAt > retentionMs) answeredRuns.delete(runId);
    }
  };
  const isSynthesizedToolFailure = (event) => {
    const text = String(event?.payload?.text ?? "").trim();
    return event?.kind === "final" &&
      event?.payload?.isError === true &&
      /^⚠️\s+.*\sfailed(?::|$)/iu.test(text);
  };
  return {
    shouldSuppress(event) {
      const current = now();
      prune(current);
      if (!event?.runId || !isSynthesizedToolFailure(event)) return false;
      const answeredAt = answeredRuns.get(event.runId);
      if (answeredAt == null || current - answeredAt > retentionMs) return false;
      answeredRuns.delete(event.runId);
      return true;
    },
    recordHumanFinal(event) {
      if (event?.kind !== "final" || !event?.runId || event?.payload?.isError === true) return;
      const payload = event.payload ?? {};
      const hasVisibleContent = Boolean(
        String(payload.text ?? "").trim() ||
        payload.mediaUrl ||
        payload.mediaUrls?.length ||
        payload.presentation,
      );
      if (!hasVisibleContent) return;
      const current = now();
      prune(current);
      answeredRuns.set(event.runId, current);
    },
  };
}

export async function retrySlackRateLimit(task, { attempts = 4, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      const retryAfter = Number(error?.data?.retry_after ?? error?.retryAfter ?? error?.headers?.["retry-after"]);
      const rateLimited = error?.data?.error === "ratelimited" || /rate limit/i.test(String(error));
      if (!rateLimited || !Number.isFinite(retryAfter) || attempt === attempts - 1) throw error;
      await sleep(Math.max(1, retryAfter) * 1000);
    }
  }
}

// Form-encoded, not JSON. Slack's read methods — conversations.replies among
// them — reject a JSON body with invalid_arguments, and resolveThreadRoot
// swallows that as "no root", which silently keys every provenance lookup to
// the wrong session. Every call here passes flat string params, so form
// encoding is correct for all of them.
export async function slackApi(method, token, body) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    body: new URLSearchParams(
      Object.entries(body ?? {})
        .filter(([, value]) => value != null)
        .map(([key, value]) => [key, String(value)]),
    ).toString(),
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(`slack ${method} failed: ${payload.error}`);
  return payload;
}

// The gateway sometimes keys an outbound delivery session by the inbound message
// ts rather than the thread root, which sends every provenance lookup to a
// session that never ran a model call. Slack is the authority on the root.
export async function resolveThreadRoot(channel, ts, token, cache = new Map(), call = slackApi) {
  if (!channel || !ts) return ts;
  const key = `${channel}:${ts}`;
  if (cache.has(key)) return cache.get(key);
  let root = ts;
  try {
    const payload = await call("conversations.replies", token, { channel, ts, limit: 1 });
    root = payload.messages?.[0]?.thread_ts ?? payload.messages?.[0]?.ts ?? ts;
  } catch {
    root = ts;
  }
  cache.set(key, root);
  return root;
}

export function rememberInboundThreadRoot(event, ctx, cache = new Map()) {
  if (String(event?.channel ?? ctx?.channelId ?? "").toLowerCase() !== "slack") return;
  const channel = String(
    event?.conversationId ?? ctx?.conversationId ?? event?.metadata?.channelId ?? event?.metadata?.channel ?? "",
  ).replace(/^channel:/, "").toUpperCase();
  const messageTs = String(event?.messageId ?? event?.metadata?.messageId ?? "");
  const rootTs = String(
    event?.threadId ?? event?.replyToId ?? event?.metadata?.threadId ?? event?.metadata?.threadTs ?? messageTs,
  );
  if (!channel || !messageTs || !rootTs) return;
  cache.set(`${channel}:${messageTs}`, rootTs);
  return { channel, rootTs };
}

export function isAcpBindingSession(sessionKey) {
  return /^agent:[^:]+:acp:binding:/i.test(String(sessionKey ?? ""));
}

export function rememberAcpBoundThread(event, ctx, cache = new Map()) {
  if (!isAcpBindingSession(ctx?.sessionKey)) return;
  if (ctx?.channelId !== "slack") return;
  const channel = String(
    ctx.conversationId ?? event?.metadata?.channelId ?? event?.metadata?.channel ?? "",
  ).replace(/^channel:/, "").toUpperCase();
  const rootTs = String(
    event?.threadId ??
      event?.replyToId ??
      event?.metadata?.threadId ??
      event?.metadata?.threadTs ??
      event?.metadata?.rootTs ??
      event?.messageId ??
      event?.metadata?.messageId ??
      "",
  );
  if (!channel || !rootTs) return;
  cache.set(ctx.sessionKey, { channel, rootTs });
}

export function boundThreadFromSession(sessionKey, cache = new Map()) {
  return sessionKey ? cache.get(sessionKey) : undefined;
}

export function sessionBoundThread(session) {
  if (!session || typeof session !== "object") return;
  const rootTs = String(
    session.origin?.threadId ?? session.deliveryContext?.threadId ?? session.lastThreadId ?? "",
  );
  const channel = String(session.origin?.nativeChannelId ?? session.origin?.to ?? "")
    .replace(/^channel:/, "")
    .toUpperCase();
  if (!rootTs) return;
  return { channel: channel || undefined, rootTs };
}

const WORK_NARRATION = /^(i['’]ll|i will|i need|next i['’]ll|let me|looking at|closing this|working on|checking|the close path|orienting)\b/i;

export function isWorkNarration(content) {
  return WORK_NARRATION.test(String(content ?? "").trim());
}

export function isLongRunKickoff(content) {
  const source = String(content ?? "").trim();
  if (!source || /^##\s/m.test(source)) return false;
  if (isWorkNarration(source)) return false;
  const lines = source.split(/\n/).filter((line) => line.trim());
  return lines.length === 1 && source.length < 200;
}

export function extractPublishedReply(content) {
  const source = String(content ?? "").trim();
  if (!source) return "";
  const parts = source.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const tldr = parts.findLastIndex((part) => /^## TLDR\s*$/i.test(part.split("\n", 1)[0]));
  if (tldr >= 0) return parts.slice(tldr).join("\n\n");
  const status = parts.findLastIndex((part) => /^## Status\s*$/i.test(part.split("\n", 1)[0]));
  if (status >= 0) {
    let start = status;
    while (start > 0 && !isWorkNarration(parts[start - 1])) start -= 1;
    return parts.slice(start).join("\n\n");
  }
  let start = -1;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (/^##\s/.test(parts[i]) || (!isWorkNarration(parts[i]) && parts[i].length > 80)) {
      start = i;
      break;
    }
  }
  if (start >= 0) return parts.slice(start).join("\n\n");
  const last = parts.at(-1) ?? source;
  if (isWorkNarration(last) && !isLongRunKickoff(last)) return "";
  return last;
}

export function acpProjectionDecision(kind, content) {
  void kind;
  const source = String(content ?? "").trim();
  if (isLongRunKickoff(source)) return { deliver: true, text: source };
  const published = extractPublishedReply(source);
  if (!published) return { deliver: false };
  if (isWorkNarration(published) && !/^##\s/m.test(published)) return { deliver: false };
  return { deliver: true, text: published };
}

// Ownership decides what we are allowed to remove, so it cannot be guessed.
// The send-side hook context does not carry the bot's own user id, so ask
// Slack once per token and keep it.
export async function resolveBotUserId(token, cache = new Map(), call = slackApi) {
  if (!token) return undefined;
  if (cache.has(token)) return cache.get(token);
  let userId;
  try {
    userId = (await call("auth.test", token, {}))?.user_id;
  } catch {
    userId = undefined;
  }
  if (userId) cache.set(token, userId);
  return userId;
}

export function sessionKeyForRoot(sessionKey, root) {
  if (!sessionKey || !root) return undefined;
  const rekeyed = sessionKey.replace(/(:thread:)[^:]+$/i, `$1${root}`);
  return rekeyed === sessionKey ? undefined : rekeyed;
}

export function slackRouteFromSessionKey(sessionKey) {
  const match = String(sessionKey ?? "").match(/:slack:channel:([^:]+):thread:([^:]+)$/i);
  if (!match) return;
  return { channel: match[1].toUpperCase(), rootTs: match[2] };
}

export function redactSlackReferences(content) {
  return String(content ?? "").replace(/\b\d{10}\.\d{6}\b/g, "internal Slack reference");
}

// The route cache exists for a send that outran its own session's events. Two
// agents legitimately share one thread, so a key of channel+root alone hands
// one agent the other's provenance — Liv's sends in a thread Max was building
// in went out signed sol/codex (2026-08-18). The agent id is part of the key.
export function routeCacheKey(agentId, channel, ts) {
  if (!agentId || !channel || !ts) return undefined;
  return `${String(agentId).toLowerCase()}:${String(channel).toLowerCase()}:${ts}`;
}

// The effective reasoning level when run events carry none: an explicit
// per-session override wins, else the agent's configured default. Codex runs
// never emit a thinking level in model events, so without this every codex
// signature omitted the tile while the resolved value sat provable in config.
export function resolveConfiguredThinking(config, agentId) {
  if (!agentId) return undefined;
  const id = String(agentId).toLowerCase();
  const entry = (config?.agents?.list ?? []).find((agent) => String(agent?.id ?? "").toLowerCase() === id);
  return entry?.thinkingDefault ?? config?.agents?.defaults?.thinkingDefault;
}

// Persistent ACP bindings do not emit OpenClaw model-call events because the
// provider runs inside the external harness. The binding session and the
// configured ACP command still prove the harness and its selected model. Keep
// this narrow: only an explicit Cursor --model value earns provenance.
export function resolveConfiguredAcpProvenance(config, sessionKey, route = {}) {
  const session = String(sessionKey ?? "");
  const match = session.match(/^agent:([^:]+):/i);
  if (!match) return;
  const agentId = match[1].toLowerCase();
  if (!isAcpBindingSession(session)) {
    const accountId = String(route.accountId ?? "").toLowerCase();
    const peerId = String(route.peerId ?? route.channel ?? "").toLowerCase();
    const bound = (config?.bindings ?? []).some((binding) =>
      binding?.type === "acp" &&
      String(binding?.agentId ?? "").toLowerCase() === agentId &&
      String(binding?.match?.channel ?? "").toLowerCase() === "slack" &&
      String(binding?.match?.accountId ?? "").toLowerCase() === accountId &&
      String(binding?.match?.peer?.id ?? "").toLowerCase() === peerId);
    if (!bound) return;
  }
  const agent = (config?.agents?.list ?? []).find((entry) => String(entry?.id ?? "").toLowerCase() === agentId);
  const acpAgentId = String(agent?.runtime?.acp?.agent ?? "").toLowerCase();
  if (agent?.runtime?.type !== "acp" || acpAgentId !== "cursor") return;
  const args = config?.plugins?.entries?.acpx?.config?.agents?.[acpAgentId]?.args;
  if (!Array.isArray(args)) return;
  const modelFlag = args.findIndex((arg) => arg === "--model");
  const model = modelFlag >= 0 ? String(args[modelFlag + 1] ?? "").trim().toLowerCase() : "";
  if (!model) return;
  return {
    model: `cursor/${model}`,
    provider: "cursor",
    harnessId: "cursor",
    sessionKey,
  };
}

async function loadSessionThinking(sessionKey) {
  const agentId = sessionKey?.match(/^agent:([^:]+)/)?.[1];
  if (!agentId) return;
  const sessionsPath = `${HOME}/.openclaw/agents/${agentId}/sessions/sessions.json`;
  const sessions = JSON.parse(await readFile(sessionsPath, "utf8"));
  return sessions[sessionKey]?.thinkingLevel;
}

// The in-memory provenance maps die with the process, so the first reply after
// every gateway restart went out bare. The per-agent last-known provenance is
// tiny and changes rarely — persist it beside the fault journal, seed on boot.
const AGENT_PROVENANCE_SNAPSHOT = `${HOME}/.openclaw/run-signature/agent-provenance.json`;

export async function saveAgentProvenance(byAgent, path = AGENT_PROVENANCE_SNAPSHOT) {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(Object.fromEntries(byAgent), null, 2)}\n`);
  } catch {
    // The snapshot is a warm-start aid. It must never affect delivery.
  }
}

export async function loadAgentProvenance(path = AGENT_PROVENANCE_SNAPSHOT) {
  try {
    const entries = Object.entries(JSON.parse(await readFile(path, "utf8")));
    return new Map(entries.filter(([, value]) => value && typeof value === "object" && value.model));
  } catch {
    return new Map();
  }
}

async function loadSessionBoundThread(sessionKey) {
  const agentId = sessionKey?.match(/^agent:([^:]+)/)?.[1];
  if (!agentId) return;
  const sessionsPath = `${HOME}/.openclaw/agents/${agentId}/sessions/sessions.json`;
  try {
    const sessions = JSON.parse(await readFile(sessionsPath, "utf8"));
    return sessionBoundThread(sessions[sessionKey]);
  } catch {
    return;
  }
}

async function loadSessionProvenance(sessionKey) {
  const agentId = sessionKey?.match(/^agent:([^:]+)/)?.[1];
  if (!agentId) return;
  const sessionsPath = `${HOME}/.openclaw/agents/${agentId}/sessions/sessions.json`;
  const sessions = JSON.parse(await readFile(sessionsPath, "utf8"));
  const session = sessions[sessionKey];
  if (!session?.model) return;
  return {
    model: session.model,
    provider: session.modelProvider,
    harnessId: /^(?:openai|codex)$/i.test(session.modelProvider ?? "") ? "codex" : undefined,
    // Only an explicit per-session override is stored here; the configured
    // default never reaches the session row, so its absence stays an absence.
    thinkLevel: session.thinkingLevel,
    sessionKey,
  };
}

// Slack answers `already_reacted` / `no_reaction` when the strip is already in
// the state the write was taking it to — a concurrent send got there first.
// That is the outcome we wanted, not a failure.
function tolerantWrite(task) {
  return task().catch((error) => {
    if (/already_reacted|no_reaction/.test(String(error))) return;
    throw error;
  });
}

export default {
  id: "run-signature",
  name: "Run Signature",
  description: "Adds run signatures and maintains the root status tile.",
  register(api) {
    const excludedChannels = new Set((api.pluginConfig?.excludedChannels ?? []).map((value) => String(value).toUpperCase()));
    const ownerLabel = String(api.pluginConfig?.ownerLabel ?? "Human");
    const isExcludedChannel = (channel) => excludedChannels.has(String(channel ?? "").toUpperCase());
    const byRun = new Map();
    const bySession = new Map();
    const byRoute = new Map();
    const byAgent = new Map();
    const rootCache = new Map();
    const acpBoundThreads = new Map();
    const botIdCache = new Map();
    const faultedRoots = new Set();
    const pendingCloses = new Map();
    const serializeRunStrip = createKeyedSerialQueue();
    const threadOwnershipConfig = api.pluginConfig?.threadOwnership;
    const threadOwnership = threadOwnershipConfig?.enabled === true
      ? createThreadOwnershipRuntime({
          accounts: threadOwnershipConfig.accounts,
          resolveUnclaimedOwner: async (event, ctx) => {
            const route = slackRouteFromSessionKey(ctx.sessionKey);
            const channel = String(event.conversationId ?? ctx.conversationId ?? route?.channel ?? "").replace(/^channel:/, "").toUpperCase();
            const rootTs = String(event.threadId ?? event.replyToId ?? route?.rootTs ?? "");
            const accountId = event.accountId ?? ctx.accountId;
            if (!channel || !rootTs || !accountId) return;
            const accountRuntime = await import(resolveSlackRuntimeModule("accounts"));
            const token = accountRuntime.resolveSlackAccount({ cfg: api.config, accountId })?.botToken;
            if (!token) return;
            const messages = (await slackApi("conversations.replies", token, { channel, ts: rootTs, limit: 1000 })).messages ?? [];
            return inferThreadOwnerFromMessages(messages, threadOwnershipConfig.accounts);
          },
        })
      : undefined;

    if (threadOwnership) {
      api.on("inbound_claim", async (event, ctx) => {
        const claim = await threadOwnership.claim(event, ctx);
        if (claim.handled) {
          api.logger?.info?.(`thread ownership handled inbound for ${event.accountId ?? ctx.accountId ?? "unknown"}: ${claim.reason}; owner=${claim.owner ?? "none"}`);
          return {handled: true};
        }
        const route = rememberInboundThreadRoot(event, ctx, rootCache);
        if (!route || isExcludedChannel(route.channel)) return;
        const accountId = event.accountId ?? ctx.accountId;
        try {
          const accounts = await import(resolveSlackRuntimeModule("accounts"));
          const token = accounts.resolveSlackAccount({ cfg: api.config, accountId })?.botToken;
          if (!token) throw new Error(`the claimed account ${accountId ?? "unknown"} has no Slack token`);
          await maintainStatusTile("no_action", ctx, {
            channel: route.channel,
            rootTs: route.rootTs,
            routeKey: `${route.channel.toLowerCase()}:${route.rootTs}`,
            accountId,
            token,
          });
        } catch (error) {
          api.logger?.error?.(`run-signature could not clear the prior inbound obligation: ${String(error)}`);
        }
      });
    }

    // Seed the last-resort fallback from the previous process's snapshot, so
    // the first reply after a restart still carries tiles. Live events win.
    let agentSnapshotSerialized;
    void loadAgentProvenance().then((loaded) => {
      for (const [agentId, provenance] of loaded) {
        if (!byAgent.has(agentId)) byAgent.set(agentId, provenance);
      }
    });

    const rememberProvenance = (event, ctx) => {
      const sessionKey = event.sessionKey ?? ctx.sessionKey;
      const prior = (sessionKey ? bySession.get(sessionKey) : undefined) ??
        (event.runId ? byRun.get(event.runId) : undefined);
      const provenance = mergeProvenance(prior, {
        model: event.resolvedRef ?? event.model ?? ctx.modelId,
        provider: event.provider ?? ctx.modelProviderId,
        harnessId: event.harnessId ?? ctx.agentHarnessId,
        sessionKey,
        thinkLevel: event.thinkLevel ?? ctx.thinkLevel,
        reasoningLevel: event.reasoningLevel ?? ctx.reasoningLevel,
        reasoningEffort: event.reasoningEffort ?? ctx.reasoningEffort,
      });
      if ((provenance.thinkLevel ?? provenance.reasoningLevel ?? provenance.reasoningEffort) != null && !resolveThinkingTile(provenance)) {
        api.logger?.warn?.(`thinking_unknown session=${provenance.sessionKey ?? "unknown"}`);
      }
      if (event.runId) {
        byRun.set(event.runId, provenance);
      }
      if (provenance.sessionKey) {
        bySession.set(provenance.sessionKey, provenance);
        const eventAgentId = provenance.sessionKey.match(/^agent:([^:]+)/i)?.[1];
        const route = provenance.sessionKey.match(/:slack:channel:([^:]+):thread:([^:]+)/i);
        const key = route ? routeCacheKey(eventAgentId, route[1], route[2]) : undefined;
        if (key) byRoute.set(key, provenance);
        // Last resort for a send with no session of its own — a fresh thread
        // root, a cron post, a ghost delivery row. The agent's most recent run
        // is what is actually answering, so its tiles are right far more often
        // than no tiles at all.
        if (eventAgentId && provenance.model) byAgent.set(eventAgentId.toLowerCase(), provenance);
      }
      const serialized = JSON.stringify(Object.fromEntries(byAgent));
      if (serialized !== agentSnapshotSerialized) {
        agentSnapshotSerialized = serialized;
        void saveAgentProvenance(byAgent);
      }
    };

    api.on("model_call_started", rememberProvenance);
    api.on("llm_input", rememberProvenance);
    api.on("llm_output", rememberProvenance);
    api.on("message_received", (event, ctx) => {
      rememberInboundThreadRoot(event, ctx, rootCache);
      rememberAcpBoundThread(event, ctx, acpBoundThreads);
    });

    const journalFault = async (channel, rootTs, reason) => {
      faultedRoots.add(`${channel}:${rootTs}`);
      await appendFaultJournal({ channel, rootTs, reason });
    };

    const journalRecovery = async (channel, rootTs) => {
      const key = `${channel}:${rootTs}`;
      if (!faultedRoots.delete(key)) return;
      await appendFaultJournal({ channel, rootTs, recovered: true });
    };

    const toolFailureDeduper = createToolFailureDeduper();

    api.on("reply_payload_sending", async (event, ctx) => {
      if (toolFailureDeduper.shouldSuppress(event)) {
        api.logger?.info?.(`run-signature suppressed recovered tool warning for run=${event.runId}`);
        return { cancel: true, reason: "the same run already delivered a human final" };
      }
      let payload = event.payload;
      if (isAcpBindingSession(ctx.sessionKey) && event.kind !== "tool") {
        const decision = acpProjectionDecision(event.kind, payload?.text);
        if (!decision.deliver) {
          api.logger?.info?.(`run-signature cancelled ACP ${event.kind} projection`);
          return { cancel: true, reason: "ACP mid-turn text is not a published post" };
        }
        if (decision.text !== String(payload?.text ?? "").trim()) {
          payload = { ...payload, text: decision.text };
        }
      }
      if (event.kind === "final") toolFailureDeduper.recordHumanFinal({ ...event, payload });
      return payload !== event.payload ? { payload } : undefined;
    });

    // This hook must never be the reason a reply fails to reach the human, so
    // every path below either succeeds, journals, or returns quietly. The root
    // status tile is maintained after the final payload is normalized.
    api.on("message_sending", async (event, ctx) => {
      if (ctx.channelId !== "slack") return;
      const channel = String(event.to ?? "").replace(/^channel:/, "").toUpperCase();
      // Guest channels keep plain guest prose and carry no operational state.
      if (isExcludedChannel(channel)) return;
      let normalized = normalizeOutboundStatus(redactSlackReferences(event.content), {
        explicitStatus: event.metadata?.outboundStatus,
        ownerLabel,
      });
      if (normalized.status === "closed") {
        try {
          const route = slackRouteFromSessionKey(ctx.sessionKey);
          const rootTs = String(event.threadId ?? event.replyToId ?? route?.rootTs ?? "");
          if (!channel || !rootTs) throw new Error("the canonical Slack thread root is unavailable");
          const accountId = ctx.accountId ?? event.metadata?.accountId ?? ctx.sessionKey?.match(/^agent:([^:]+)/)?.[1];
          const accounts = await import(resolveSlackRuntimeModule("accounts"));
          const token = accounts.resolveSlackAccount({ cfg: api.config, accountId })?.botToken;
          if (!token) throw new Error("the sending Slack account has no resolved token");
          const messages = (await slackApi("conversations.replies", token, { channel, ts: rootTs, limit: 1000 })).messages ?? [];
          const stats = measureSlackThread(messages);
          const agent = String(accountId ?? "").toLowerCase();
          const usage = await loadThreadUsage({ agent, channel, thread: rootTs });
          const summary = closeSummary(normalized.content, ownerLabel);
          normalized = { status: "closed", content: formatCloseOut({ summary, stats, usage, agent, ownerLabel }) };
          pendingCloses.set(ctx.sessionKey, { channel, thread: rootTs, agent, summary, stats, usage, ownerLabel });
        } catch (error) {
          api.logger?.error?.(`run-signature refused an unmeasured session close: ${String(error)}`);
          normalized = {
            status: "no_action",
            content: `⚠️ ${String(ctx.accountId ?? "Agent")} could not close this thread durably. The thread remains open; the failure is in the operational log.`,
          };
        }
      }
      const outbound = {
        ...event,
        content: normalized.content,
        metadata: { ...event.metadata, outboundStatus: normalized.status },
      };
      try {
        await signAndMark(outbound, ctx);
      } catch (error) {
        api.logger?.error?.(`run-signature hook failed, delivering anyway: ${String(error)}`);
      }
      if (normalized.content !== event.content) return { content: normalized.content };
    });

    // The per-message signature needs the Slack ts, which does not exist until
    // delivery succeeds. message_sent is observation-only, so a reaction
    // failure can be journaled without ever risking the reply itself.
    api.on("message_sent", async (event, ctx) => {
      try {
        await reactToSentMessage(event, ctx);
      } catch (error) {
        api.logger?.error?.(`run-signature message_sent hook failed: ${String(error)}`);
      }
      const pendingClose = pendingCloses.get(ctx.sessionKey);
      if (pendingClose && event.success && event.messageId) {
        try {
          await recordSessionClose({
            dataRoot: DATA_ROOT,
            ...pendingClose,
            closeMessageId: String(event.messageId),
          });
        } catch (error) {
          api.logger?.error?.(`run-signature could not record delivered session close: ${String(error)}`);
          await appendFaultJournal({ channel: pendingClose.channel, rootTs: pendingClose.thread, reason: `delivered close was not recorded: ${String(error)}` });
        } finally {
          pendingCloses.delete(ctx.sessionKey);
        }
      } else if (pendingClose && event.success === false) {
        pendingCloses.delete(ctx.sessionKey);
      }
    });

    async function signAndMark(event, ctx) {
      if (ctx.channelId !== "slack") return;
      const channel = String(event.to ?? "").replace(/^channel:/, "").toUpperCase();
      // Guest channel: no signature, no tile — no ops provenance at all there.
      if (isExcludedChannel(channel)) return;
      const sessionRoute = slackRouteFromSessionKey(ctx.sessionKey);
      let rawTs = String(
        event.threadId ?? event.replyToId ?? boundThreadFromSession(ctx.sessionKey, acpBoundThreads)?.rootTs ?? sessionRoute?.rootTs ?? "",
      );
      if (!rawTs && isAcpBindingSession(ctx.sessionKey)) {
        rawTs = String((await loadSessionBoundThread(ctx.sessionKey))?.rootTs ?? "");
      }
      const accountId = ctx.accountId ?? event.metadata?.accountId ?? ctx.sessionKey?.match(/^agent:([^:]+)/)?.[1];
      const accounts = await import(resolveSlackRuntimeModule("accounts"));
      const token = accounts.resolveSlackAccount({ cfg: api.config, accountId })?.botToken;
      if (!token) {
        api.logger?.error?.(`run-signature could not resolve a Slack token for account ${accountId ?? "unknown"}`);
      }

      const rootTs = rawTs && token ? await resolveThreadRoot(channel, rawTs, token, rootCache) : undefined;
      const routeKey = `${channel.toLowerCase()}:${rootTs ?? rawTs ?? "channel"}`;
      api.logger?.info?.(`message_sending channel=slack account=${accountId ?? "missing"} session=${ctx.sessionKey ?? "missing"} raw=${rawTs || "none"} root=${rootTs ?? "none"}`);

      // Status is independent of provenance. A missing model signature must
      // never leave a stale root tile behind.
      if (rootTs && token) {
        await maintainStatusTile(event.metadata?.outboundStatus, ctx, { channel, rootTs, routeKey, accountId, token });
      }

      // The source is diagnostic state: a tile missing from a live-event
      // provenance is a gateway plumbing gap, while the same miss from a disk
      // or last-run fallback only says this send outran its own events.
      const agentId = String(accountId ?? "").toLowerCase() || undefined;
      let provenance = resolveConfiguredAcpProvenance(api.config, ctx.sessionKey, { accountId, channel });
      let provenanceSource = provenance ? "configured_acp_route" : "live_session_events";
      if (!provenance) provenance = ctx.sessionKey ? bySession.get(ctx.sessionKey) : undefined;
      if (!provenance) {
        provenance = byRoute.get(routeCacheKey(agentId, channel, rootTs ?? rawTs)) ??
          byRoute.get(routeCacheKey(agentId, channel, rawTs));
        if (provenance) provenanceSource = "route_cache";
      }
      // Fall back to disk, root-keyed session first: the raw-keyed row is the
      // ghost delivery session, and its model is usually null.
      for (const candidate of [rootTs ? sessionKeyForRoot(ctx.sessionKey, rootTs) : undefined, ctx.sessionKey]) {
        if (provenance || !candidate) continue;
        try {
          provenance = await loadSessionProvenance(candidate);
          if (provenance) {
            provenanceSource = "session_store_disk";
            rememberProvenance(provenance, {});
          }
        } catch (error) {
          api.logger?.error?.(`session provenance recovery failed for ${candidate}: ${String(error)}`);
        }
      }

      if (!provenance && accountId) {
        provenance = byAgent.get(String(accountId).toLowerCase());
        if (provenance) provenanceSource = "agent_last_run";
      }

      // Never cancel the reply. An unmarked message the human can read beats a
      // silently dropped one; the miss goes to the journal, not the thread.
      if (!provenance) {
        api.logger?.error?.(`run-signature has no provenance for ${routeKey}; delivering unmarked`);
        if (rootTs) await journalFault(channel, rootTs, "this run could not be attributed to a model, so the per-message signature was skipped");
        return;
      }

      // Run events are the first source for the reasoning level, but codex
      // runs never emit one. The resolved value is still provable: an explicit
      // per-session override on disk, else the agent's configured default.
      // Only when neither exists is the tile omitted and thinking_unknown
      // logged (status-framework.md).
      if (!resolveThinkingTile(provenance)) {
        let effective;
        for (const candidate of [rootTs ? sessionKeyForRoot(ctx.sessionKey, rootTs) : undefined, ctx.sessionKey, provenance.sessionKey]) {
          if (effective != null || !candidate) continue;
          effective = await loadSessionThinking(candidate).catch(() => undefined);
        }
        effective = effective ?? resolveConfiguredThinking(api.config, agentId ?? provenance.sessionKey?.match(/^agent:([^:]+)/i)?.[1]);
        if (normalizeThinkingLevel(effective)) {
          provenance = { ...provenance, thinkLevel: effective };
        } else {
          api.logger?.info?.(`run-signature thinking_unknown for ${routeKey}: effective reasoning level not provable this run; tile omitted (source ${provenanceSource})`);
        }
      }

      if (!resolveModelTile(provenance.model)) {
        // A signature without a model tile is junk; deliver unmarked and journal.
        api.logger?.error?.(`run-signature cannot build a signature for ${routeKey}: no model tile for ${provenance?.model ?? "unknown"} (source ${provenanceSource})`);
        if (rootTs) await journalFault(channel, rootTs, `there is no model tile for ${provenance?.model ?? "unknown"}`);
      }

    }

    async function reactToSentMessage(event, ctx) {
      if (ctx.channelId !== "slack" || !event.success || !event.messageId) return;
      const channel = String(event.to ?? "").replace(/^channel:/, "").toUpperCase();
      // Guest channel: no signature, no tile — no ops provenance at all there.
      if (!channel || isExcludedChannel(channel)) return;
      const messageTs = String(event.messageId);
      const accountId = ctx.accountId ?? ctx.sessionKey?.match(/^agent:([^:]+)/)?.[1];
      const agentId = String(accountId ?? "").toLowerCase() || undefined;
      const accounts = await import(resolveSlackRuntimeModule("accounts"));
      const token = accounts.resolveSlackAccount({ cfg: api.config, accountId })?.botToken;
      if (!token) {
        api.logger?.error?.(`run-signature could not resolve a Slack token for account ${accountId ?? "unknown"}`);
        await appendFaultJournal({ channel, messageTs, reason: "the sending account's Slack token could not be resolved" });
        return;
      }

      let provenance = resolveConfiguredAcpProvenance(api.config, ctx.sessionKey, { accountId, channel });
      let provenanceSource = provenance ? "configured_acp_route" : "live_session_events";
      if (!provenance) provenance = ctx.sessionKey ? bySession.get(ctx.sessionKey) : undefined;
      if (provenance && !resolveHarnessTile(provenance) && ctx.sessionKey) {
        try {
          const recovered = await loadSessionProvenance(ctx.sessionKey);
          const completed = recoverMissingHarness(provenance, recovered);
          if (completed !== provenance) {
            provenance = completed;
            provenanceSource = "live_session_events+session_store_disk";
            rememberProvenance(provenance, {});
          }
        } catch (error) {
          api.logger?.error?.(`session harness recovery failed for ${ctx.sessionKey}: ${String(error)}`);
        }
      }
      if (!provenance && ctx.sessionKey) {
        try {
          provenance = await loadSessionProvenance(ctx.sessionKey);
          if (provenance) {
            provenanceSource = "session_store_disk";
            rememberProvenance(provenance, {});
          }
        } catch (error) {
          api.logger?.error?.(`session provenance recovery failed for ${ctx.sessionKey}: ${String(error)}`);
        }
      }
      if (!provenance && accountId) {
        provenance = byAgent.get(String(accountId).toLowerCase());
        if (provenance) provenanceSource = "agent_last_run";
      }
      if (!provenance) {
        api.logger?.error?.(`run-signature has no provenance for ${channel}:${messageTs}; delivering unmarked`);
        await appendFaultJournal({ channel, messageTs, reason: "this sent message could not be attributed to a model, so its reaction signature was skipped" });
        return;
      }

      if (!resolveThinkingTile(provenance)) {
        const effective = (ctx.sessionKey ? await loadSessionThinking(ctx.sessionKey).catch(() => undefined) : undefined) ??
          resolveConfiguredThinking(api.config, agentId ?? provenance.sessionKey?.match(/^agent:([^:]+)/i)?.[1]);
        if (normalizeThinkingLevel(effective)) {
          provenance = { ...provenance, thinkLevel: effective };
        } else {
          api.logger?.info?.(`run-signature thinking_unknown for ${channel}:${messageTs}: effective reasoning level not provable; tile omitted (source ${provenanceSource})`);
        }
      }

      const reactionNames = buildRunReactionNames(provenance);
      if (!resolveModelTile(provenance.model)) {
        api.logger?.error?.(`run-signature cannot build reactions for ${channel}:${messageTs}: no model tile for ${provenance?.model ?? "unknown"} (source ${provenanceSource})`);
        await appendFaultJournal({ channel, messageTs, reason: `there is no model tile for ${provenance?.model ?? "unknown"}` });
        return;
      }

      await serializeRunStrip(`${channel.toLowerCase()}:${messageTs}`, async () => {
        const actions = await import(resolveSlackRuntimeModule("actions"));
        const opts = { cfg: api.config, accountId, token };
        const call = (task) => retrySlackRateLimit(task);
        try {
          // Slack renders reactions in first-added order. Add sequentially so
          // runtime → model → harness → thinking stays readable.
          await addReactionsInOrder(reactionNames, (name) =>
            tolerantWrite(() => call(() => actions.reactSlackMessage(channel, messageTs, name, opts))));
        } catch (error) {
          api.logger?.error?.(`run-signature reaction signature failed for ${channel}:${messageTs}: ${String(error)}`);
          await appendFaultJournal({ channel, messageTs, reason: String(error?.message ?? error) });
        }
      });
    }

    async function maintainStatusTile(outboundStatus, ctx, { channel, rootTs, routeKey, accountId, token }) {
      await serializeRunStrip(routeKey, async () => {
        const actions = await import(resolveSlackRuntimeModule("actions"));
        const accounts = await import(resolveSlackRuntimeModule("accounts"));
        const call = (task) => retrySlackRateLimit(task);
        const opts = { cfg: api.config, accountId, token };
        const sendingBotId = ctx.botUserId ?? await resolveBotUserId(token, botIdCache);
        // Without our own user id, ownership claims every tile on the root —
        // including the other agent's. On a shared root that is active
        // corruption, strictly worse than a stale tile.
        if (!sendingBotId) {
          api.logger?.error?.(`run-signature could not resolve its own bot user id for ${routeKey}; status tile left untouched`);
          await journalFault(channel, rootTs, "the bot's own user id could not be resolved, so the status tile was left untouched");
          return;
        }
        // Every gateway-hosted account, not just the sender's: forward cleanup
        // removes each agent's legacy provenance tiles with the token that
        // holds them, because only that token can.
        const accountIds = [...new Set([accountId, ...Object.keys(api.config?.channels?.slack?.accounts ?? {})].filter(Boolean))];
        const fleet = new Map([[sendingBotId, { accountId, token }]]);
        for (const id of accountIds) {
          const candidate = accounts.resolveSlackAccount({ cfg: api.config, accountId: id })?.botToken;
          if (!candidate) continue;
          const userId = await resolveBotUserId(candidate, botIdCache);
          if (userId && !fleet.has(userId)) fleet.set(userId, { accountId: id, token: candidate });
        }
        const botUserIds = new Set(fleet.keys());
        const optsFor = (holder) => {
          const entry = fleet.get(holder);
          return entry ? { cfg: api.config, accountId: entry.accountId, token: entry.token } : opts;
        };
        try {
          const observed = normalizeReactions(await call(() => actions.listSlackReactions(channel, rootTs, opts)));
          const lifecycle = resolveStatusTile(outboundStatus, observed, botUserIds);
          const plan = planStatusTile(observed, { lifecycle, sendingBotId, botUserIds });
          for (const { name, holders } of plan.remove) {
            for (const holder of holders) await tolerantWrite(() => call(() => actions.removeSlackReaction(channel, rootTs, name, optsFor(holder))));
          }
          for (const { name, holders } of plan.add) {
            for (const holder of holders) await tolerantWrite(() => call(() => actions.reactSlackMessage(channel, rootTs, name, optsFor(holder))));
          }
          await journalRecovery(channel, rootTs);
          try {
            await recordOutboundStatus({
              channel,
              threadId: rootTs,
              status: outboundStatus,
              agent: String(accountId ?? "").toLowerCase() || undefined,
              traceId: ctx.traceId,
              sessionKey: ctx.sessionKey,
              runId: ctx.runId,
            });
          } catch (error) {
            api.logger?.error?.(`run-signature could not record outbound status for ${routeKey}: ${String(error)}`);
          }
        } catch (error) {
          api.logger?.error?.(`run-signature status tile failed for ${routeKey}: ${String(error)}`);
          await journalFault(channel, rootTs, String(error?.message ?? error));
        }
      });
    }
  },
};
