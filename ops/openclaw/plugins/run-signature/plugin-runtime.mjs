import { appendFile, mkdir, readFile } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import {loadSessionEntry} from "./session-store.mjs";
import { homedir } from "node:os";
import {
  resolveModelTile,
  resolveHarnessTile,
  resolveThinkingTile,
  normalizeThinkingLevel,
} from "./strip-core.mjs";
import {registerWorkThreadTool} from "./work-thread-tool.mjs";
import {registerHostClose} from "./host-close.mjs";
import {registerThreadLead} from "./thread-lead.mjs";
import {registerSwitchModelTool} from "./switch-model-tool.mjs";
import {createStatusProjector} from "./status-projector.mjs";
import {resolveSlackChannel, slackRouteFromSessionKey} from "./slack-route.mjs";

export {slackRouteFromSessionKey};

export {closeThreadTool} from "./host-close.mjs";
export {allowedModels, applySessionSelection, resolveRequestedModel, switchModelTool} from "./switch-model-tool.mjs";

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
  if (!prior.includes(`"id":${JSON.stringify(event.id)}`)) await appendFile(path, `${JSON.stringify(event)}\n`, {mode: 0o600});
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
// hold the thinking level but llm_output never does. Overwriting per event meant the last event erased
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

export function buildRunReactionNames(provenance) {
  const tiles = [
    resolveModelTile(provenance.model),
    resolveHarnessTile(provenance.harnessId),
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

// Form-encoded, not JSON: Slack's read methods, conversations.replies among
// them, reject a JSON body with invalid_arguments. Every call here passes flat
// string params, so form encoding is correct for all of them.
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

export function resolveSlackChannelId(event, ctx) {
  return resolveSlackChannel({
    channel: event?.to,
    sessionKey: ctx?.sessionKey,
    origin: {
      conversationId: event?.conversationId ?? event?.metadata?.channelId ?? event?.metadata?.channel ?? ctx?.conversationId,
    },
  });
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

// The harness is a property of the execution profile the host selected for
// the turn, never of model output: the session's recorded harness, else the
// runtime the profile catalog binds to the session's selected model (a switch
// in the thread, then the agent's default, or the agent's ACP runtime).
export function resolveSelectedHarness(config, agentId, session = {}) {
  if (session.agentHarnessId) return session.agentHarnessId;
  const agent = configuredAgent(config, agentId);
  if (agent?.runtime?.type === "acp") return agent.runtime.acp?.agent;
  const selected = session.modelOverride ? `${session.providerOverride ?? session.modelProvider ?? ""}/${session.modelOverride}`
    : session.model && session.modelProvider ? `${session.modelProvider}/${session.model}` : undefined;
  const ref = selected ?? (typeof agent?.model === "string" ? agent.model : agent?.model?.primary ?? config?.agents?.defaults?.model?.primary);
  return (agent?.models?.[ref] ?? config?.agents?.defaults?.models?.[ref])?.agentRuntime?.id;
}

async function loadSessionThinking(sessionKey) {
  return (await loadSessionEntry(sessionKey))?.thinkingLevel;
}

async function loadSessionProvenance(config, sessionKey) {
  const session = await loadSessionEntry(sessionKey);
  if (!session?.model) return;
  const agentId = String(sessionKey ?? "").match(/^agent:([^:]+):/i)?.[1];
  return {
    model: session.model,
    provider: session.modelProvider,
    harnessId: resolveSelectedHarness(config, agentId, session),
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

const plugin = {
  id: "run-signature",
  name: "Run Signature",
  description: "Adds run signatures and maintains the root status tile.",
  register(api) {
    const excludedChannels = new Set((api.pluginConfig?.excludedChannels ?? []).map((value) => String(value).toUpperCase()));
    const isExcludedChannel = (channel) => excludedChannels.has(String(channel ?? "").toUpperCase());
    const byRun = new Map();
    const bySession = new Map();
    const byAgent = new Map();
    const botIdCache = new Map();
    const serializeRunStrip = createKeyedSerialQueue();
    const maintainStatusTile = createStatusProjector(api, {appendFaultJournal, botIdCache,
      resolveBotUserId, resolveSlackRuntimeModule, retrySlackRateLimit, serialize: serializeRunStrip});

    const workThreadPosts = new Set();
    const slackBotUserIds = async () => {
      const accounts = await import(resolveSlackRuntimeModule("accounts"));
      const ids = new Set();
      for (const accountId of Object.keys(api.config?.channels?.slack?.accounts ?? {})) {
        const id = await resolveBotUserId(accounts.resolveSlackAccount({cfg: api.config, accountId})?.botToken, botIdCache);
        if (id) ids.add(id);
      }
      return ids;
    };
    registerWorkThreadTool(api, {resolveSlackRuntimeModule, retrySlackRateLimit, maintainStatusTile, workThreadPosts});
    registerHostClose(api, {isExcludedChannel, maintainStatusTile, recordOutboundStatus, appendFaultJournal, resolveDataRoot, resolveSlackRuntimeModule, slackApi});
    registerSwitchModelTool(api);
    registerThreadLead(api, {isExcludedChannel, botUserIds: slackBotUserIds});

    const rememberProvenance = async (event, ctx) => {
      const sessionKey = event.sessionKey ?? ctx.sessionKey;
      const prior = (sessionKey ? bySession.get(sessionKey) : undefined) ??
        (event.runId ? byRun.get(event.runId) : undefined);
      const agentId = String(sessionKey ?? "").match(/^agent:([^:]+):/i)?.[1];
      const session = sessionKey ? await loadSessionEntry(sessionKey).catch(() => undefined) : undefined;
      const provenance = mergeProvenance(prior, {
        model: event.resolvedRef ?? event.model ?? ctx.modelId,
        provider: event.provider ?? ctx.modelProviderId,
        harnessId: resolveSelectedHarness(api.config, agentId, session),
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
        // Last resort for a send with no session of its own — a fresh thread
        // root, a cron post, a ghost delivery row. The agent's most recent run
        // is what is actually answering, so its tiles are right far more often
        // than no tiles at all.
        if (eventAgentId && provenance.model) byAgent.set(eventAgentId.toLowerCase(), provenance);
      }
    };

    api.on("model_call_started", rememberProvenance);
    api.on("llm_input", rememberProvenance);
    api.on("llm_output", rememberProvenance);
    api.on('message_sent', async (event, ctx) => {
      try { await reactToSentMessage(event, ctx); }
      catch (error) { await appendFaultJournal({reason: `Run signature: ${String(error)}`}); }
    });

    async function reactToSentMessage(event, ctx) {
      if (ctx.channelId !== "slack" || !event.success || !event.messageId) return;
      // Work-thread scaffolding (title root and brief) is posted by the tool, not a model turn: no signature.
      if (workThreadPosts.delete(String(event.content ?? "").trim())) return;
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

      let provenance = ctx.sessionKey ? bySession.get(ctx.sessionKey) : undefined;
      let provenanceSource = "live_session_events";
      if (!provenance && ctx.sessionKey) {
        try {
          provenance = await loadSessionProvenance(api.config, ctx.sessionKey);
          if (provenance) {
            provenanceSource = "session_store_disk";
            await rememberProvenance(provenance, {});
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

      if (!provenance.harnessId)
        await appendFaultJournal({ channel, messageTs, reason: "the selected execution profile did not identify a harness, so the harness tile was omitted" });

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

  },
};

export default plugin;
