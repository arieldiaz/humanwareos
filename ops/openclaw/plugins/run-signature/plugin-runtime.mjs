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
import {installHumanStatusEventBridge} from "./human-status-events.mjs";
import {resolveSlackChannel, slackRouteFromSessionKey} from "./slack-route.mjs";
import {setThreadStatusTool} from "./status-command.mjs";

export {slackRouteFromSessionKey};

export {closeThreadTool} from "./host-close.mjs";
export {setThreadStatusTool} from "./status-command.mjs";
export {allowedModels, applySessionSelection, resolveRequestedModel, switchModelTool} from "./switch-model-tool.mjs";

export {
  resolveModelTile,
  resolveHarnessTile,
  resolveThinkingTile,
  normalizeThinkingLevel,
} from "./strip-core.mjs";

// Faults go to a machine-readable journal, not just a human-readable log line.
// ops/openclaw/tools/error-digest.mjs reads this; a cron reads the digest. The
// journal and the digest are the whole monitoring path: strip problems are
// cosmetic and never earn a post in the thread they happened in.
const HOME = homedir();
const STATE_ROOT = process.env.OPENCLAW_STATE_DIR || join(HOME, ".openclaw");
const FAULT_JOURNAL = `${STATE_ROOT}/run-signature/faults.jsonl`;
async function recordRunLifecycle({ dataRoot, channel, threadId, status, agent, traceId, sessionKey, runId, recovery }) {
  if (!channel || !threadId) return;
  if (!dataRoot) throw new Error("the canonical Humanware data root is unavailable");
  const ts = new Date().toISOString();
  const event = {
    schemaVersion: 2,
    id: `lifecycle:${channel}:${threadId}:${runId ?? ts}:${recovery ? "recovery" : status}`,
    traceId: traceId ?? `lifecycle:${channel}:${threadId}`,
    ts,
    logicalSessionId: `slack:${channel}:${threadId}`,
    runtimeSessionId: null,
    agent: agent ?? null,
    source: "openclaw",
    kind: "lifecycle.set",
    level: "normal",
    summary: status ? `Lifecycle ${status}` : "Clear interrupted lifecycle",
    details: {channelId: channel, threadId, lifecycle: status, ...(status == null ? {remove: true} : {})},
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

// The session row is what the gateway actually ran this turn with: it is
// rewritten at run start and by switch_model, so reading it at send time is
// per-message truth. Live hook events were cached per session instead, and a
// cached model outlived a mid-thread switch.
export async function loadSessionProvenance(config, sessionKey, load = loadSessionEntry) {
  const session = await load(sessionKey);
  if (!session?.model) return;
  const agentId = String(sessionKey ?? "").match(/^agent:([^:]+):/i)?.[1];
  return {
    model: session.modelOverride ?? session.model,
    provider: session.providerOverride ?? session.modelProvider,
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
  description: "Adds per-message run signatures and captures human root-status events.",
  register(api) {
    const excludedChannels = new Set((api.pluginConfig?.excludedChannels ?? []).map((value) => String(value).toUpperCase()));
    const isExcludedChannel = (channel) => excludedChannels.has(String(channel ?? "").toUpperCase());
    const botIdCache = new Map();
    const serializeRunStrip = createKeyedSerialQueue();
    const dataRoot = resolveDataRoot(api.config, api.pluginConfig);
    const uninstallHumanStatusBridge = installHumanStatusEventBridge({
      dataRoot,
      actorIds: api.pluginConfig?.humanStatusActors,
    });
    api.on("gateway_stop", uninstallHumanStatusBridge);

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
    registerWorkThreadTool(api, {resolveSlackRuntimeModule, retrySlackRateLimit, workThreadPosts});
    registerHostClose(api, {isExcludedChannel, recordRunLifecycle, appendFaultJournal, resolveDataRoot, resolveSlackRuntimeModule, slackApi});
    api.registerTool?.({contextVersion: 2, create: context => setThreadStatusTool(context, {dataRoot})}, {name: "set_thread_status"});
    registerSwitchModelTool(api);
    registerThreadLead(api, {isExcludedChannel, botUserIds: slackBotUserIds});

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

      let provenance;
      try {
        provenance = ctx.sessionKey ? await loadSessionProvenance(api.config, ctx.sessionKey) : undefined;
      } catch (error) {
        api.logger?.error?.(`session provenance read failed for ${ctx.sessionKey}: ${String(error)}`);
      }
      if (!provenance) {
        api.logger?.error?.(`run-signature has no provenance for ${channel}:${messageTs}; delivering unmarked`);
        await appendFaultJournal({ channel, messageTs, reason: "this sent message could not be attributed to a model, so its reaction signature was skipped" });
        return;
      }

      if (!provenance.harnessId)
        await appendFaultJournal({ channel, messageTs, reason: "the selected execution profile did not identify a harness, so the harness tile was omitted" });

      if (!resolveThinkingTile(provenance)) {
        const effective = resolveConfiguredThinking(api.config, agentId);
        if (normalizeThinkingLevel(effective)) {
          provenance = { ...provenance, thinkLevel: effective };
        } else {
          api.logger?.info?.(`run-signature thinking_unknown for ${channel}:${messageTs}: effective reasoning level not provable; tile omitted`);
        }
      }

      const reactionNames = buildRunReactionNames(provenance);
      if (!resolveModelTile(provenance.model)) {
        api.logger?.error?.(`run-signature cannot build reactions for ${channel}:${messageTs}: no model tile for ${provenance?.model ?? "unknown"}`);
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
