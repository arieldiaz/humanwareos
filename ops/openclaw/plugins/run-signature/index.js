import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import {loadSessionEntry} from "./session-store.mjs";
import { homedir } from "node:os";
import {
  ADMITTED_STATUS,
  normalizeReactions,
  resolveModelTile,
  resolveHarnessTile,
  resolveThinkingTile,
  normalizeThinkingLevel,
  resolveStatusTile,
  planStatusTile,
} from "./strip-core.mjs";
import { createThreadOwnershipRuntime, inferThreadOwnerFromMessages } from "./thread-ownership.mjs";
import {
  loadThreadUsage,
  measureSlackThread,
  recordSessionClose,
} from "./session-close.mjs";
import {FinalRuntime, FINAL_RUNTIME} from "./final-runtime.mjs";
import { startSlackWorkThread } from "../../slack-spin-out.mjs";
import { ConversationFenceStore, conversationFenceRoute, isHumanSlackUserProfile } from "./conversation-fence.mjs";

export {
  normalizeReactions,
  resolveModelTile,
  resolveHarnessTile,
  resolveThinkingTile,
  normalizeThinkingLevel,
  ADMITTED_STATUS,
  resolveStatusTile,
  planStatusTile,
  tileKind,
} from "./strip-core.mjs";

// Faults go to a machine-readable journal, not just a human-readable log line.
// ops/openclaw/tools/error-digest.mjs reads this; a cron reads the digest. The
// journal and the digest are the whole monitoring path: strip problems are
// cosmetic and never earn a post in the thread they happened in.
const HOME = homedir();
const STATE_ROOT = process.env.OPENCLAW_STATE_DIR || join(HOME, ".openclaw");
const FAULT_JOURNAL = `${STATE_ROOT}/run-signature/faults.jsonl`;
const OUTBOUND_EMOJI = {
  act: "raised_hand",
  working: "arrows_counterclockwise",
  scheduled: "calendar",
  closed: "white_check_mark",
};

async function recordOutboundStatus({ dataRoot, channel, threadId, status, agent, traceId, sessionKey, runId, recovery }) {
  if (!channel || !threadId) return;
  if (!dataRoot) throw new Error("the canonical Humanware data root is unavailable");
  const ts = new Date().toISOString();
  const event = {
    schemaVersion: 2,
    id: `status:${channel}:${threadId}:${runId ?? ts}:${recovery ? "recovery" : status}`,
    traceId: traceId ?? `status:${channel}:${threadId}`,
    ts,
    logicalSessionId: `slack:${channel}:${threadId}`,
    runtimeSessionId: null,
    agent: agent ?? null,
    source: "openclaw",
    kind: "status.set",
    level: "normal",
    summary: status ? `Status ${status}` : "Clear interrupted working",
    details: { channelId: channel, threadId, status, emoji: OUTBOUND_EMOJI[status], ...(status == null ? {remove: true} : {}) },
    sourceRef: {sessionKey: sessionKey ?? null, runId: runId ?? null},
  };
  const path = join(dataRoot, "evidence", "sessions", "events", `${ts.slice(0, 10)}.jsonl`);
  await mkdir(dirname(path), { recursive: true });
  let prior = '';
  try { prior = await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!prior.split('\n').some(line => line && JSON.parse(line).id === event.id))
    await appendFile(path, `${JSON.stringify(event)}\n`, {mode: 0o600});
}

async function appendFaultJournal(entry) {
  try {
    await mkdir(dirname(FAULT_JOURNAL), { recursive: true });
    await appendFile(FAULT_JOURNAL, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // The journal is diagnostics. It must never affect delivery.
  }
}

const SLACK_PROJECTS_DIR = `${STATE_ROOT}/npm/projects`;

// The gateway's Slack package lives under a generation-hashed directory and its
// dist chunks are content-hashed; both change on every OpenClaw update.
// Prefer the stable named exports; newer internal chunks use minified exports.
// Older releases expose named exports through per-kind runtime chunks.
export function resolveSlackRuntimeModule(kind, { projectsDir = SLACK_PROJECTS_DIR, list = readdirSync, stat = statSync } = {}) {
  const projects = list(projectsDir)
    .filter((name) => name.startsWith("openclaw-slack-"))
    .map((name) => ({ name, mtime: stat(`${projectsDir}/${name}`)?.mtimeMs ?? 0 }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!projects.length) throw new Error(`no openclaw-slack package under ${projectsDir}`);
  const dist = `${projectsDir}/${projects[0].name}/node_modules/@openclaw/slack/dist`;
  const files = list(dist);
  if ((kind === "actions" || kind === "accounts") && files.includes("runtime-api.js")) return `${dist}/runtime-api.js`;
  const chunk = files.find((name) => name.startsWith(`${kind}.runtime-`) && name.endsWith(".js"));
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

export function resolveSlackChannelId(event, ctx) {
  const direct = String(event?.to ?? event?.conversationId ?? event?.metadata?.channelId ?? event?.metadata?.channel ?? ctx?.conversationId ?? "")
    .replace(/^channel:/i, "")
    .toUpperCase();
  if (/^[CDG][A-Z0-9]+$/.test(direct)) return direct;
  return slackRouteFromSessionKey(ctx?.sessionKey)?.channel;
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
function configuredAgent(config, agentId) {
  const id = String(agentId).toLowerCase();
  if (config?.agents?.entries && typeof config.agents.entries === "object") {
    return Object.entries(config.agents.entries).find(([key]) => key.toLowerCase() === id)?.[1];
  }
  return (config?.agents?.list ?? []).find((agent) => String(agent?.id ?? "").toLowerCase() === id);
}

export function resolveDataRoot(config, pluginConfig, agentId, env = process.env) {
  const explicit = String(pluginConfig?.dataRoot ?? env.HUMANWARE_DATA_ROOT ?? "").trim();
  if (explicit) return isAbsolute(explicit) ? explicit : undefined;
  const workspace = String(configuredAgent(config, agentId)?.workspace ?? "").replace(/\/$/, "");
  const agentsDir = dirname(workspace);
  const workingDir = dirname(agentsDir);
  return isAbsolute(workspace) && basename(agentsDir) === "agents" && basename(workingDir) === "working"
    ? dirname(workingDir)
    : undefined;
}

export function resolveConfiguredThinking(config, agentId) {
  if (!agentId) return undefined;
  const entry = configuredAgent(config, agentId);
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
  const agent = configuredAgent(config, agentId);
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
  return (await loadSessionEntry(sessionKey))?.thinkingLevel;
}

// The in-memory provenance maps die with the process, so the first reply after
// every gateway restart went out bare. The per-agent last-known provenance is
// tiny and changes rarely — persist it beside the fault journal, seed on boot.
const AGENT_PROVENANCE_SNAPSHOT = `${STATE_ROOT}/run-signature/agent-provenance.json`;

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
  return sessionBoundThread(await loadSessionEntry(sessionKey));
}

async function loadSessionProvenance(sessionKey) {
  const session = await loadSessionEntry(sessionKey);
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
    const humanUserCache = new Map();
    const faultedRoots = new Set();
    const humanInputs = new Map();
    const serializeRunStrip = createKeyedSerialQueue();
    const threadOwnershipConfig = api.pluginConfig?.threadOwnership;
    const conversationFences = new ConversationFenceStore();

    const finalRuntime = new FinalRuntime({
      root: join(STATE_ROOT, 'run-signature'), fences: conversationFences, humanInputs,
      excluded: isExcludedChannel,
      project: async (status, turn) => {
        const accounts = await import(resolveSlackRuntimeModule('accounts'));
        const token = accounts.resolveSlackAccount({cfg: api.config, accountId: turn.accountId})?.botToken;
        if (!token) throw new Error('No account token for lifecycle projection');
        await maintainStatusTile(status, {sessionKey: turn.sessionKey, runId: turn.runId}, {
          channel: turn.route.channel, rootTs: turn.route.threadId,
          routeKey: turn.conversation, accountId: turn.accountId, token,
        });
      },
      record: turn => recordOutboundStatus({dataRoot: resolveDataRoot(api.config, api.pluginConfig, turn.accountId),
        channel: turn.route.channel, threadId: turn.route.threadId, status: turn.status,
        agent: turn.accountId, sessionKey: turn.sessionKey, runId: turn.runId, recovery: turn.recovery}),
      fault: (turn, reason) => appendFaultJournal({runId: turn.runId, channel: turn.route.channel, rootTs: turn.route.threadId, reason}),
      send: turn => api.runtime.gateway.request('send', {
        channel: 'slack', accountId: turn.accountId, agentId: turn.accountId,
        to: `channel:${turn.route.channel}`, threadId: turn.route.threadId,
        sessionKey: turn.sessionKey, message: turn.envelope.message,
        idempotencyKey: `humanware-final:${turn.key}`,
      }),
      wakes: async sessionKey => {
        const jobs = [];
        let offset = 0;
        do {
          const result = await api.runtime.gateway.request('cron.list', {includeDisabled: false, limit: 100, offset});
          jobs.push(...(result.jobs ?? []).filter(job => job.sessionKey === sessionKey));
          if (result.nextOffset == null) break;
          if (result.nextOffset <= offset) throw new Error('Scheduler pagination did not advance');
          offset = result.nextOffset;
        } while (true);
        return jobs;
      },
      close: async (turn, messageId) => {
        const closing = await conversationFences.beginClosing(turn.route, {accountId: turn.accountId});
        if (!closing.accepted && closing.fence?.closeMessageId !== messageId) throw new Error('Conversation close was not accepted');
        if (closing.accepted) await conversationFences.commitClose(turn.route, closing.token, {messageId});
        const accounts = await import(resolveSlackRuntimeModule('accounts'));
        const token = accounts.resolveSlackAccount({cfg: api.config, accountId: turn.accountId})?.botToken;
        const messages = (await slackApi('conversations.replies', token, {channel: turn.route.channel, ts: turn.route.threadId, limit: 1000})).messages ?? [];
        await recordSessionClose({dataRoot: resolveDataRoot(api.config, api.pluginConfig, turn.accountId),
          channel: turn.route.channel, thread: turn.route.threadId, agent: turn.accountId,
          closeMessageId: messageId, summary: turn.envelope.message, stats: measureSlackThread(messages),
          usage: await loadThreadUsage({agent: turn.accountId, channel: turn.route.channel, thread: turn.route.threadId}), ownerLabel});
      },
    });
    globalThis[FINAL_RUNTIME] = finalRuntime;
    api.on('gateway_start', () => finalRuntime.recover());
    api.on('before_tool_call', (event, ctx) => {
      if (finalRuntime.active.get(ctx.runId ?? event.runId)?.repair)
        return {block: true, blockReason: 'Final-envelope repair cannot repeat tools'};
      const params = event.params ?? {};
      const emoji = String(params.emoji ?? '').replaceAll(':', '');
      if (/(?:^|__)message$/.test(event.toolName) && params.action === 'react' &&
          (!emoji || ['arrows_counterclockwise', 'raised_hand', 'hand', 'calendar', 'white_check_mark', '🔄', '✋', '🗓', '🗓️', '✅'].includes(emoji)))
        return {block: true, blockReason: 'Lifecycle reactions belong to the projector'};
    });

    const isHumanSlackInbound = async (event, ctx) => {
      if (event.senderIsOwner === true) return true;
      const senderId = String(event.senderId ?? ctx.senderId ?? "").trim();
      if (!senderId) return false;
      const accounts = await import(resolveSlackRuntimeModule("accounts"));
      const accountIds = Object.keys(api.config?.channels?.slack?.accounts ?? {});
      const botUserIds = new Set();
      for (const accountId of accountIds) {
        const token = accounts.resolveSlackAccount({ cfg: api.config, accountId })?.botToken;
        if (!token) continue;
        const botUserId = await resolveBotUserId(token, botIdCache);
        if (botUserId) botUserIds.add(botUserId);
      }
      if (botUserIds.has(senderId)) return false;
      if (humanUserCache.has(senderId)) return humanUserCache.get(senderId);
      const accountId = event.accountId ?? ctx.accountId;
      const token = accounts.resolveSlackAccount({ cfg: api.config, accountId })?.botToken;
      if (!token) return false;
      try {
        const humanAuthored = isHumanSlackUserProfile((await slackApi("users.info", token, { user: senderId }))?.user);
        humanUserCache.set(senderId, humanAuthored);
        return humanAuthored;
      } catch {
        return false;
      }
    };

    api.registerTool?.((context) => {
      if (context.messageChannel !== "slack") return;
      const channel = String(context.nativeChannelId ?? "").replace(/^channel:/i, "").toUpperCase();
      const agentId = String(context.agentId ?? "").toLowerCase();
      const accountId = context.agentAccountId ?? agentId;
      if (!channel || !agentId || !accountId) return;
      return {
        name: "start_work_thread",
        description: "Start substantial Slack work in its normal shape with one call: one short single-line root, the full brief as the first reply, a working status, and a durable high-reasoning session that begins immediately. Use this instead of separate message and sessions_spawn calls.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["title", "detail"],
          properties: {
            title: { type: "string", minLength: 1, description: "Short one-line root title." },
            detail: { type: "string", minLength: 1, description: "Complete work brief for reply one and the work session." },
            group: { type: "string", description: "Optional dashboard group." },
          },
        },
        async execute(toolCallId, args) {
          try {
            const accounts = await import(resolveSlackRuntimeModule("accounts"));
            const token = accounts.resolveSlackAccount({ cfg: api.config, accountId })?.botToken;
            if (!token) throw new Error(`Slack account ${accountId} has no bot token`);
            const clearScaffold = async ({ messageIds }) => {
              try {
                const actions = await import(resolveSlackRuntimeModule("actions"));
                const opts = { cfg: api.config, accountId, token };
                for (const messageId of messageIds) {
                  await retrySlackRateLimit(() => actions.removeOwnSlackReactions(channel, messageId, opts));
                }
              } catch (error) {
                api.logger?.warn?.(`run-signature could not clear scaffold reactions: ${String(error)}`);
              }
            };
            const result = await startSlackWorkThread({
              accountId,
              agentId,
              channel,
              title: args.title,
              detail: args.detail,
              group: args.group,
              parentSessionKey: context.sessionKey,
              operationId: toolCallId,
              send: (params) => api.runtime.gateway.request("send", params),
              prepareScaffold: clearScaffold,
              setStatus: ({ rootMessageId, status }) => maintainStatusTile(status, context, {
                channel,
                rootTs: rootMessageId,
                routeKey: `${channel.toLowerCase()}:${rootMessageId}`,
                accountId,
                token,
              }),
              createSession: (params) => api.runtime.gateway.request("sessions.create", params),
            });
            return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
          } catch (error) {
            return { content: [{ type: "text", text: String(error?.message ?? error) }], isError: true };
          }
        },
      };
    }, { name: "start_work_thread" });

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

    api.on("inbound_claim", async (event, ctx) => {
      const route = rememberInboundThreadRoot(event, ctx, rootCache);
      if (route && !isExcludedChannel(route.channel)) {
        const humanAuthored = await isHumanSlackInbound(event, ctx);
        if (humanAuthored) {
          await finalRuntime.human({channel: route.channel, threadId: route.rootTs}, {
            messageId: String(event.messageId ?? ctx.messageId ?? ''), text: event.content,
          });
        } else if (conversationFences.shouldSuppress({ channel: route.channel, threadId: route.rootTs })) {
          api.logger?.info?.(`run-signature fenced non-human inbound for closed conversation ${route.channel}:${route.rootTs}`);
          return { handled: true };
        }
      }
      if (threadOwnership) {
        const claim = await threadOwnership.claim(event, ctx);
        if (claim.handled) {
          api.logger?.info?.(`thread ownership handled inbound for ${event.accountId ?? ctx.accountId ?? "unknown"}: ${claim.reason}; owner=${claim.owner ?? "none"}`);
          return {handled: true};
        }
        if (!route || isExcludedChannel(route.channel)) return;
        const accountId = event.accountId ?? ctx.accountId;
        try {
          const accounts = await import(resolveSlackRuntimeModule("accounts"));
          const token = accounts.resolveSlackAccount({ cfg: api.config, accountId })?.botToken;
          if (!token) throw new Error(`the claimed account ${accountId ?? "unknown"} has no Slack token`);
          await maintainStatusTile(ADMITTED_STATUS, ctx, {
            channel: route.channel,
            rootTs: route.rootTs,
            routeKey: `${route.channel.toLowerCase()}:${route.rootTs}`,
            accountId,
            token,
          });
        } catch (error) {
          api.logger?.error?.(`run-signature could not mark the admitted turn working: ${String(error)}`);
        }
      }
    });

    api.on("before_agent_run", (_event, ctx) => {
      const route = conversationFenceRoute({ sessionKey: ctx.sessionKey });
      if (route && conversationFences.shouldSuppress(route)) {
        return {
          outcome: "block",
          reason: "conversation lifecycle fence is closing or closed",
          category: "conversation_closed",
        };
      }

    });


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

    api.on('reply_payload_sending', async (event, ctx) => {
      try { return await finalRuntime.prepare(event, ctx); }
      catch (error) {
        await appendFaultJournal({runId: event.runId, reason: String(error)});
        return {cancel: true, reason: 'Final contract rejected delivery'};
      }
    });
    api.on('message_sending', (event, ctx) => {
      if (ctx.channelId !== 'slack') return;
      const route = conversationFenceRoute({channel: resolveSlackChannelId(event, ctx),
        threadId: event.threadId ?? event.replyToId, sessionKey: ctx.sessionKey});
      if (route && conversationFences.shouldSuppress(route))
        return {cancel: true, cancelReason: 'Conversation is closed'};
    });
    api.on('message_sent', async (event, ctx) => {
      try { await reactToSentMessage(event, ctx); }
      catch (error) { await appendFaultJournal({reason: `Run signature: ${String(error)}`}); }
    });

    async function reactToSentMessage(event, ctx) {
      if (ctx.channelId !== "slack" || !event.success || !event.messageId) return;
      const channel = resolveSlackChannelId(event, ctx);
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

        } catch (error) {
          api.logger?.error?.(`run-signature status tile failed for ${routeKey}: ${String(error)}`);
          await journalFault(channel, rootTs, String(error?.message ?? error));
        }
      });
    }
  },
};
