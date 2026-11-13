import {mkdir, readFile, rename, writeFile} from "node:fs/promises";
import {dirname} from "node:path";
import {PR_URL, readPullRequest} from "./close-report.mjs";
import {slackRoute, slackRouteFromSessionKey} from "./slack-route.mjs";

// A work thread cannot schedule its own follow-up: automations are owner-only. The plugin keeps a
// small durable registry of threads instead and checks it with plain code. A wake costs a model
// turn only when something changed or a deadline the thread itself set is due.
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
export const CHECK_BACK = {
  tickMs: 5 * MINUTE,
  firstDelayMs: 30 * MINUTE,
  minInMs: 5 * MINUTE,
  maxInMs: 24 * HOUR,
  maxAgeMs: 30 * DAY,
  maxIdleMs: 7 * DAY,
  maxPullRequests: 10,
  failedReadsBeforeWake: 3,
  reasonMax: 300,
};

const reply = (text, isError) => ({content: [{type: "text", text}], ...(isError ? {isError} : {})});
const UNOBSERVED = {state: "OPEN", checks: "pending", review: "none"};
const isTerminal = (fingerprint) => fingerprint?.state === "MERGED" || fingerprint?.state === "CLOSED";
const allDone = (prs) => Object.keys(prs).length > 0 && Object.values(prs).every(isTerminal);
const describe = (fingerprint) => {
  const {state, checks, review} = fingerprint ?? UNOBSERVED;
  return `${state}, checks ${checks}, review ${review}`;
};

// ── Pure decisions ──────────────────────────────────────────────────────────────────────────────

export function parseDuration(text) {
  const match = String(text ?? "").trim().match(/^(\d+(?:\.\d+)?)\s*(m|mins?|minutes?|h|hrs?|hours?)$/i);
  if (!match) throw new Error('`in` must be a duration such as "45m" or "2h"');
  const ms = Math.round(Number(match[1]) * (match[2][0].toLowerCase() === "h" ? HOUR : MINUTE));
  if (ms < CHECK_BACK.minInMs || ms > CHECK_BACK.maxInMs) throw new Error("`in` must be between 5 minutes and 24 hours");
  return ms;
}

export function expired(entry, now) {
  return now >= Math.min(entry.createdAt + CHECK_BACK.maxAgeMs, entry.lastActivityAt + CHECK_BACK.maxIdleMs);
}

// `gh pr view --json state,statusCheckRollup,reviewDecision`: check runs carry status/conclusion,
// commit statuses carry state; reviewDecision is empty when no review is required.
const FAILING = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);
const checkOutcome = (check) => {
  if (check.status && check.status !== "COMPLETED") return "pending";
  const result = String(check.conclusion ?? check.state ?? "").toUpperCase();
  return FAILING.has(result) ? "failing" : result === "PENDING" || result === "EXPECTED" || !result ? "pending" : "passing";
};

export function fingerprintOf(view) {
  const outcomes = (view.statusCheckRollup ?? []).map(checkOutcome);
  const review = String(view.reviewDecision ?? "").toUpperCase();
  return {
    state: String(view.state ?? "OPEN").toUpperCase(),
    checks: !outcomes.length ? "none" : outcomes.includes("failing") ? "failing" : outcomes.includes("pending") ? "pending" : "passing",
    review: review === "APPROVED" ? "approved" : review === "CHANGES_REQUESTED" ? "changes_requested" : "none",
  };
}

// A move into `pending` is recorded but is not news; the conclusion that follows it is.
export function prChanged(recorded, next) {
  const before = recorded ?? UNOBSERVED;
  if (before.state === next.state && before.checks === next.checks && before.review === next.review) return false;
  if (!recorded && isTerminal(next)) return false; // an old PR the thread merely links
  return before.state !== next.state || next.checks !== "pending" || before.review !== next.review;
}

// What one check of one entry decides, given what the readers returned. Nothing here touches time,
// disk, or network: the caller applies the plan only after the wake call resolves.
export function planCheck(entry, readings, now) {
  const reasons = [], prs = {}, readFailures = {...entry.readFailures};
  const due = entry.dueAt != null && now >= entry.dueAt;
  if (due) reasons.push(`a check-back is due: ${entry.reason ?? "no reason recorded"}`);
  for (const [url, reading] of Object.entries(readings)) {
    if (reading.error != null) {
      readFailures[url] = (readFailures[url] ?? 0) + 1;
      if (readFailures[url] >= CHECK_BACK.failedReadsBeforeWake) {
        reasons.push(`could not read PR state: ${url}: ${reading.error}`);
        readFailures[url] = 0;
      }
      continue;
    }
    delete readFailures[url];
    if (prChanged(entry.prs[url], reading.fingerprint)) reasons.push(`${url} changed: ${describe(entry.prs[url])} → ${describe(reading.fingerprint)}`);
    prs[url] = reading.fingerprint;
  }
  const after = {...entry.prs, ...prs};
  return {reasons, prs, readFailures, clearDue: due, after, ended: allDone(after) && (due || entry.dueAt == null)};
}

export function wakeMessage({sessionKey, plan}) {
  const route = slackRouteFromSessionKey(sessionKey);
  const watched = Object.entries(plan.after).map(([url, fingerprint]) => `- ${url}: ${fingerprint ? describe(fingerprint) : "not yet read"}`);
  return [
    "Automatic check-back for this thread. No human sent a message: the host woke this session on its own schedule.",
    route && `Use Slack channel ${route.channel}, thread root ${route.rootTs} for material progress, questions, and the final result.`,
    "Why it fired:",
    ...plan.reasons.map((reason) => `- ${reason}`),
    watched.length ? "Watched pull requests now:" : "No pull requests are watched for this thread.",
    ...watched,
    "Continue the work if work remains. Call check_back to be checked again at a specific time (for example while waiting on CI, a review, a worker, or a deploy). Reply NO_REPLY if nothing needs doing.",
    plan.ended && "Every watched pull request is merged or closed, so the automatic check-back for this thread has ended; check_back re-arms it if anything remains.",
  ].filter(Boolean).join("\n");
}

// ── Durable registry ────────────────────────────────────────────────────────────────────────────

// One JSON file of entries keyed by thread session key. Every write is serialized in this process and
// replaces the file atomically, so a crash leaves the previous complete registry.
export class CheckBacks {
  #entries;
  #tail = Promise.resolve();
  constructor({path, now = Date.now, warn = () => {}}) {
    Object.assign(this, {path, now, warn});
  }
  async #load() {
    if (this.#entries) return;
    try {
      this.#entries = JSON.parse(await readFile(this.path, "utf8")).entries ?? {};
    } catch (error) {
      if (error.code !== "ENOENT") {
        this.warn(`check-back registry ${this.path} is unreadable (${String(error)}); kept as .corrupt and starting empty`);
        await rename(this.path, `${this.path}.corrupt`);
      }
      this.#entries = {};
    }
  }
  // fn edits a draft copy; the draft replaces the registry only after it is on disk.
  mutate(fn) {
    const run = this.#tail.then(async () => {
      await this.#load();
      const draft = structuredClone(this.#entries);
      const result = fn(draft);
      if (JSON.stringify(draft) !== JSON.stringify(this.#entries)) {
        await mkdir(dirname(this.path), {recursive: true, mode: 0o700});
        const temp = `${this.path}.${process.pid}.tmp`;
        await writeFile(temp, `${JSON.stringify({version: 1, entries: draft})}\n`, {mode: 0o600});
        await rename(temp, this.path);
        this.#entries = draft;
      }
      return result;
    });
    this.#tail = run.catch(() => {});
    return run;
  }
  list() {
    return this.mutate((entries) => structuredClone(Object.values(entries)));
  }
  // fn(entry) returns the replacement entry, or null to remove it. A thread that is not registered is left alone.
  update(sessionKey, fn) {
    return this.mutate((entries) => {
      if (!entries[sessionKey]) return;
      const next = fn(entries[sessionKey]);
      if (next) entries[sessionKey] = next; else delete entries[sessionKey];
    });
  }
  register(sessionKey, {firstRunEnded = false} = {}) {
    const at = this.now();
    return this.mutate((entries) => {
      entries[sessionKey] ??= {sessionKey, createdAt: at, lastActivityAt: at, firstRunEnded, prs: {}, readFailures: {}};
    });
  }
  remove(sessionKey) {
    return this.update(sessionKey, () => null);
  }
  setDeadline(sessionKey, inMs, reason) {
    const at = this.now();
    return this.register(sessionKey, {firstRunEnded: true}).then(() => this.update(sessionKey, (entry) =>
      ({...entry, lastActivityAt: at, dueAt: at + inMs, reason})));
  }
  notePullRequests(sessionKey, content) {
    const urls = String(content ?? "").match(PR_URL) ?? [];
    if (!urls.length) return;
    return this.update(sessionKey, (entry) => {
      const prs = {...entry.prs};
      for (const url of urls) if (!(url in prs) && Object.keys(prs).length < CHECK_BACK.maxPullRequests) prs[url] = null;
      return {...entry, prs};
    });
  }
  // A run a check-back woke never arms a deadline, so an idle thread cannot keep itself awake.
  noteRunEnd(sessionKey, {wokenByCheckBack = false} = {}) {
    const at = this.now();
    return this.update(sessionKey, (entry) => {
      if (wokenByCheckBack) return entry;
      const next = {...entry, lastActivityAt: at, firstRunEnded: true};
      if (!entry.firstRunEnded && entry.dueAt == null) Object.assign(next, {dueAt: at + CHECK_BACK.firstDelayMs, reason: "first check-back"});
      return next;
    });
  }
}

// ── Tick ────────────────────────────────────────────────────────────────────────────────────────

async function checkEntry(entry, {checkBacks, now, isRunning, read, wake}) {
  if (expired(entry, now)) return checkBacks.remove(entry.sessionKey);
  if (isRunning(entry.sessionKey)) return;
  const watched = Object.entries(entry.prs).filter(([, fingerprint]) => !isTerminal(fingerprint)).map(([url]) => url);
  if (!watched.length && !(entry.dueAt != null && now >= entry.dueAt)) return;
  const readings = Object.fromEntries(await Promise.all(watched.map(async (url) => {
    try { return [url, {fingerprint: fingerprintOf(await read(url))}]; }
    catch (error) { return [url, {error: String(error?.message ?? error).split("\n")[0]}]; }
  })));
  const plan = planCheck(entry, readings, now);
  if (plan.reasons.length) await wake(entry.sessionKey, wakeMessage({sessionKey: entry.sessionKey, plan}), `${entry.sessionKey}:${now}`);
  // Applied to the current entry: events during the wake call (a new PR, a new deadline) are kept.
  await checkBacks.update(entry.sessionKey, (current) => {
    const next = {...current, prs: {...current.prs, ...plan.prs}, readFailures: plan.readFailures};
    if (plan.clearDue && current.dueAt === entry.dueAt) { delete next.dueAt; delete next.reason; }
    return plan.reasons.length && plan.ended && allDone(next.prs) && next.dueAt == null ? null : next;
  });
}

// One failing entry never stops the others; its error goes to `fault`, and its state stays as it was so the next tick retries.
export async function runCheckBackTick({checkBacks, isRunning, read = readPullRequest, wake, fault, now = Date.now()}) {
  for (const entry of await checkBacks.list()) {
    try { await checkEntry(entry, {checkBacks, now, isRunning, read, wake}); }
    catch (error) { await fault(entry.sessionKey, error); }
  }
}

// ── Tool and plugin wiring ──────────────────────────────────────────────────────────────────────

export function checkBackTool(context, {checkBacks}) {
  if (context.messageChannel !== "slack" || !context.sessionKey || !slackRouteFromSessionKey(context.sessionKey)) return;
  if (!slackRoute({channel: context.nativeChannelId, threadId: context.deliveryContext?.threadId, sessionKey: context.sessionKey, origin: context.deliveryContext})) return;
  return {
    name: "check_back",
    description: "Ask to be woken in this thread later, for example while waiting on CI, a review, a worker, or a deploy. Pull requests you link in this thread are already watched automatically, so call this only for a time-based check. Use it instead of automations in a thread. A thread has one pending check; a new call replaces it. When it fires you receive a message saying it is an automatic check-back; reply NO_REPLY if nothing needs doing.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["in", "reason"],
      properties: {
        in: {type: "string", description: 'Delay from now, 5 minutes to 24 hours, such as "45m" or "2h".'},
        reason: {type: "string", minLength: 1, maxLength: CHECK_BACK.reasonMax, description: "What to look at when woken."},
      },
    },
    async execute(_toolCallId, params) {
      try {
        const inMs = parseDuration(params?.in);
        const reason = String(params?.reason ?? "").trim();
        if (!reason || reason.length > CHECK_BACK.reasonMax) throw new Error(`reason is required, at most ${CHECK_BACK.reasonMax} characters`);
        context.assertInvocationCurrent?.();
        await checkBacks.setDeadline(context.sessionKey, inMs, reason);
        return reply(`Check-back set for ${new Date(checkBacks.now() + inMs).toISOString()}: ${reason}. It replaces any earlier pending check.`);
      } catch (error) {
        return reply(String(error?.message ?? error), true);
      }
    },
  };
}

export function registerCheckBack(api, {checkBacks, lifecycle, appendFaultJournal, read = readPullRequest, tickMs = CHECK_BACK.tickMs}) {
  const wakeRuns = new Set();
  const fault = async (reason) => {
    api.logger?.error?.(`run-signature ${reason}`);
    await appendFaultJournal({reason});
  };
  const wake = async (sessionKey, message, idempotencyKey) => {
    const started = await api.runtime.subagent.run({sessionKey, message, deliver: false, idempotencyKey});
    if (started?.runId) wakeRuns.add(started.runId);
  };
  api.registerTool?.({contextVersion: 2, create: (context) => checkBackTool(context, {checkBacks})}, {name: "check_back"});
  api.on("message_sent", async (event, ctx) => {
    try { if (event.success) await checkBacks.notePullRequests(event.sessionKey ?? ctx.sessionKey, event.content); }
    catch (error) { await fault(`check-back could not record pull requests: ${String(error)}`); }
  });
  api.on("agent_end", async (event, ctx) => {
    try {
      const sessionKey = event.sessionKey ?? ctx.sessionKey;
      if (sessionKey) await checkBacks.noteRunEnd(sessionKey, {wokenByCheckBack: wakeRuns.delete(event.runId ?? ctx.runId)});
    } catch (error) { await fault(`check-back could not record a run end: ${String(error)}`); }
  });
  api.registerService?.({
    id: "run-signature-check-back",
    apiVersion: 2,
    start({scheduler}) {
      scheduler.schedule({
        id: "tick",
        delayMs: tickMs,
        everyMs: tickMs,
        run: () => runCheckBackTick({checkBacks, isRunning: (key) => lifecycle.isRunning(key), read, wake, now: scheduler.now(),
          fault: (sessionKey, error) => fault(`check-back failed for ${sessionKey}: ${String(error)}`)}),
      });
    },
  });
}
