import assert from "node:assert/strict";
import {chmod, mkdtemp, readdir, readFile, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {
  CHECK_BACK, CheckBacks, checkBackTool, expired, fingerprintOf, parseDuration, prChanged, registerCheckBack, runCheckBackTick,
} from "./check-back.mjs";
import {registerHostClose} from "./host-close.mjs";
import {ThreadLifecycle} from "./lifecycle.mjs";

const T0 = 1_800_000_000_000;
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const KEY = "agent:max:slack:channel:c123:thread:1790050400.000001";
const OTHER_KEY = "agent:max:slack:channel:c123:thread:1790050500.000001";
const PR = "https://github.com/example/repo/pull/7";
const PR_2 = "https://github.com/example/repo/pull/8";
const fp = (state = "OPEN", checks = "pending", review = "none") => ({state, checks, review});

// `gh pr view --json state,statusCheckRollup,reviewDecision` shape; checks are named by outcome.
const RUNS = {
  passing: {__typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS"},
  failing: {__typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE"},
  pending: {__typename: "CheckRun", status: "IN_PROGRESS", conclusion: ""},
};
const gh = ({state = "OPEN", checks = [], review = ""} = {}) => ({state, reviewDecision: review, statusCheckRollup: checks.map((name) => RUNS[name])});

async function rig({entries = {[KEY]: {}}, views = {}, running = () => false, now = T0} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "check-back-"));
  const state = {now, views, running, wakeError: undefined, reads: [], wakes: [], faults: []};
  const checkBacks = new CheckBacks({path: join(dir, "operations", "check-backs.json"), now: () => state.now});
  for (const [key, patch] of Object.entries(entries)) {
    await checkBacks.register(key);
    await checkBacks.update(key, (entry) => ({...entry, ...patch}));
  }
  Object.assign(state, {
    dir,
    checkBacks,
    entry: async (key = KEY) => (await checkBacks.list()).find((entry) => entry.sessionKey === key),
    tick: () => runCheckBackTick({
      checkBacks,
      now: state.now,
      isRunning: (key) => state.running(key),
      read: async (url) => {
        state.reads.push(url);
        const view = state.views[url];
        if (view instanceof Error) throw view;
        return view;
      },
      wake: async (sessionKey, message, idempotencyKey) => {
        if (state.wakeError && (!state.wakeFor || state.wakeFor === sessionKey)) throw state.wakeError;
        state.wakes.push({sessionKey, message, idempotencyKey});
      },
      fault: async (sessionKey, error) => state.faults.push({sessionKey, error: String(error)}),
    }),
  });
  return state;
}

// ── Decisions ───────────────────────────────────────────────────────────────

test("durations are bounded to 5 minutes through 24 hours", () => {
  assert.equal(parseDuration("45m"), 45 * MIN);
  assert.equal(parseDuration("2h"), 2 * HOUR);
  assert.equal(parseDuration("1.5 hours"), 90 * MIN);
  assert.equal(parseDuration("5m"), CHECK_BACK.minInMs);
  assert.equal(parseDuration("24h"), CHECK_BACK.maxInMs);
  for (const bad of ["4m", "1441m", "25h", "soon", "", "2d", undefined]) assert.throws(() => parseDuration(bad), /`in` must be/, String(bad));
});

test("fingerprints come from state, check rollup, and review decision", () => {
  const status = (state) => ({__typename: "StatusContext", state});
  const cases = [
    [gh(), fp("OPEN", "none", "none")],
    [gh({checks: ["passing", "passing"]}), fp("OPEN", "passing")],
    [gh({checks: ["passing", "pending"]}), fp("OPEN", "pending")],
    [gh({checks: ["pending", "failing"]}), fp("OPEN", "failing")],
    [{state: "MERGED", reviewDecision: "APPROVED", statusCheckRollup: [status("SUCCESS")]}, fp("MERGED", "passing", "approved")],
    [{state: "OPEN", reviewDecision: "CHANGES_REQUESTED", statusCheckRollup: [status("PENDING")]}, fp("OPEN", "pending", "changes_requested")],
    [{state: "OPEN", reviewDecision: "REVIEW_REQUIRED", statusCheckRollup: [status("ERROR")]}, fp("OPEN", "failing", "none")],
    [{state: "CLOSED"}, fp("CLOSED", "none", "none")],
  ];
  for (const [view, expected] of cases) assert.deepEqual(fingerprintOf(view), expected);
});

test("what counts as a change", () => {
  const cases = [
    ["identical", fp("OPEN", "passing"), fp("OPEN", "passing"), false],
    ["checks move to pending", fp("OPEN", "passing"), fp("OPEN", "pending"), false],
    ["pending concludes passing", fp("OPEN", "pending"), fp("OPEN", "passing"), true],
    ["pending concludes failing", fp("OPEN", "pending"), fp("OPEN", "failing"), true],
    ["passing turns failing", fp("OPEN", "passing"), fp("OPEN", "failing"), true],
    ["review arrives", fp("OPEN", "pending"), fp("OPEN", "pending", "approved"), true],
    ["merged", fp("OPEN", "passing"), fp("MERGED", "passing"), true],
    ["closed while checks pending", fp("OPEN", "pending"), fp("CLOSED", "pending"), true],
    ["never observed, still pending", null, fp("OPEN", "pending"), false],
    ["never observed, already passing", null, fp("OPEN", "passing"), true],
    ["never observed, already merged", null, fp("MERGED", "passing"), false],
    ["never observed, already closed", null, fp("CLOSED", "none"), false],
  ];
  for (const [name, recorded, next, expected] of cases) assert.equal(prChanged(recorded, next), expected, name);
});

test("a thread expires at the earlier of 30 days since creation and 7 days since activity", () => {
  const entry = {createdAt: T0, lastActivityAt: T0};
  assert.equal(expired(entry, T0 + 7 * DAY - 1), false);
  assert.equal(expired(entry, T0 + 7 * DAY), true);
  const active = {createdAt: T0, lastActivityAt: T0 + 29 * DAY};
  assert.equal(expired(active, T0 + 30 * DAY - 1), false);
  assert.equal(expired(active, T0 + 30 * DAY), true);
});

// ── Tick ────────────────────────────────────────────────────────────────────

test("nothing watched and nothing due costs no read and no wake", async () => {
  const f = await rig({entries: {[KEY]: {}, [OTHER_KEY]: {dueAt: T0 + HOUR, reason: "later"}}});
  await f.tick();
  assert.deepEqual([f.reads, f.wakes, f.faults], [[], [], []]);
});

test("unchanged fingerprints make no wake", async () => {
  const f = await rig({entries: {[KEY]: {prs: {[PR]: fp("OPEN", "passing", "approved")}}}, views: {[PR]: gh({checks: ["passing"], review: "APPROVED"})}});
  await f.tick();
  assert.deepEqual(f.reads, [PR]);
  assert.deepEqual(f.wakes, []);
});

test("a move to pending is recorded without a wake, and the conclusion after it wakes once", async () => {
  const f = await rig({entries: {[KEY]: {prs: {[PR]: fp("OPEN", "passing")}}}, views: {[PR]: gh({checks: ["pending"]})}});
  await f.tick();
  assert.equal(f.wakes.length, 0);
  assert.deepEqual((await f.entry()).prs[PR], fp("OPEN", "pending"));

  f.views[PR] = gh({checks: ["passing"]});
  await f.tick();
  assert.equal(f.wakes.length, 1);
  assert.match(f.wakes[0].message, /OPEN, checks pending, review none → OPEN, checks passing, review none/);
  assert.deepEqual((await f.entry()).prs[PR], fp("OPEN", "passing"));

  await f.tick();
  assert.equal(f.wakes.length, 1, "the same state wakes only once");
});

test("a first observation that is only pending is recorded silently", async () => {
  const f = await rig({entries: {[KEY]: {prs: {[PR]: null}}}, views: {[PR]: gh({checks: ["pending"]})}});
  await f.tick();
  assert.equal(f.wakes.length, 0);
  assert.deepEqual((await f.entry()).prs[PR], fp("OPEN", "pending"));
});

test("a PR first seen already merged is recorded, never wakes, and is not read again", async () => {
  const f = await rig({entries: {[KEY]: {prs: {[PR]: null}}}, views: {[PR]: gh({state: "MERGED", checks: ["passing"]})}});
  await f.tick();
  await f.tick();
  assert.equal(f.wakes.length, 0);
  assert.deepEqual(f.reads, [PR], "terminal PRs are not read twice");
  assert.equal((await f.entry()).prs[PR].state, "MERGED");
});

test("open to merged wakes once and ends the entry, and the message says so", async () => {
  const f = await rig({entries: {[KEY]: {prs: {[PR]: fp("OPEN", "passing", "approved")}}}, views: {[PR]: gh({state: "MERGED", checks: ["passing"], review: "APPROVED"})}});
  await f.tick();
  assert.equal(f.wakes.length, 1);
  assert.match(f.wakes[0].message, /OPEN, checks passing, review approved → MERGED, checks passing, review approved/);
  assert.match(f.wakes[0].message, /has ended; check_back re-arms it/);
  assert.equal(await f.entry(), undefined);
});

test("one merged PR does not end the entry while another is still open", async () => {
  const f = await rig({entries: {[KEY]: {prs: {[PR]: fp("OPEN", "passing"), [PR_2]: fp("OPEN", "pending")}}},
    views: {[PR]: gh({state: "MERGED", checks: ["passing"]}), [PR_2]: gh({checks: ["pending"]})}});
  await f.tick();
  assert.equal(f.wakes.length, 1);
  assert.doesNotMatch(f.wakes[0].message, /has ended/);
  assert.ok(await f.entry());
});

test("the wake message is self-contained", async () => {
  const f = await rig({entries: {[KEY]: {dueAt: T0 - 1, reason: "CI for the migration", prs: {[PR]: fp("OPEN", "pending")}}}, views: {[PR]: gh({checks: ["failing"]})}});
  await f.tick();
  const {message, sessionKey} = f.wakes[0];
  assert.equal(sessionKey, KEY);
  assert.match(message, /Automatic check-back/);
  assert.match(message, /No human sent a message/);
  assert.match(message, /Slack channel C123, thread root 1790050400\.000001/);
  assert.match(message, /scheduled is due \(CI for the migration\)/);
  assert.match(message, new RegExp(`${PR}: OPEN, checks failing, review none`));
  assert.match(message, /Continue the work if work remains/);
  assert.match(message, /Call check_back/);
  assert.match(message, /NO_REPLY/);
});

test("a deadline wake clears the deadline and the reason, and needs no read", async () => {
  const f = await rig({entries: {[KEY]: {dueAt: T0, reason: "waiting on the deploy"}}});
  await f.tick();
  assert.equal(f.reads.length, 0);
  assert.equal(f.wakes.length, 1);
  assert.match(f.wakes[0].message, /waiting on the deploy/);
  const entry = await f.entry();
  assert.equal(entry.dueAt, undefined);
  assert.equal(entry.reason, undefined);
  await f.tick();
  assert.equal(f.wakes.length, 1);
});

test("a future deadline does not wake", async () => {
  const f = await rig({entries: {[KEY]: {dueAt: T0 + 1}}});
  await f.tick();
  assert.equal(f.wakes.length, 0);
});

test("a rejected wake keeps the deadline and fingerprints, journals the failure, and the next tick retries", async () => {
  const f = await rig({entries: {[KEY]: {dueAt: T0 - 1, reason: "check", prs: {[PR]: fp("OPEN", "pending")}}}, views: {[PR]: gh({checks: ["passing"]})}});
  f.wakeError = new Error("gateway busy");
  await f.tick();
  assert.equal(f.faults.length, 1);
  assert.match(f.faults[0].error, /gateway busy/);
  const kept = await f.entry();
  assert.equal(kept.dueAt, T0 - 1);
  assert.equal(kept.reason, "check");
  assert.deepEqual(kept.prs[PR], fp("OPEN", "pending"));

  f.wakeError = undefined;
  await f.tick();
  assert.equal(f.wakes.length, 1);
  assert.match(f.wakes[0].message, /checks pending, review none → OPEN, checks passing/);
  assert.equal((await f.entry()).dueAt, undefined);
});

test("three failed reads of one PR wake once, then the count starts over", async () => {
  const f = await rig({entries: {[KEY]: {prs: {[PR]: fp("OPEN", "passing")}}}, views: {[PR]: new Error("gh: not found")}});
  await f.tick();
  await f.tick();
  assert.equal(f.wakes.length, 0);
  await f.tick();
  assert.equal(f.wakes.length, 1);
  assert.match(f.wakes[0].message, new RegExp(`could not read PR state: ${PR}: gh: not found`));
  assert.deepEqual((await f.entry()).prs[PR], fp("OPEN", "passing"), "the old record is kept");
  await f.tick();
  assert.equal(f.wakes.length, 1);
  f.views[PR] = gh({checks: ["passing"]});
  await f.tick();
  assert.equal((await f.entry()).readFailures[PR], undefined, "a good read clears the count");
});

test("a thread with a running turn is skipped this tick", async () => {
  const f = await rig({entries: {[KEY]: {dueAt: T0 - 1, reason: "x", prs: {[PR]: fp("OPEN", "pending")}}}, views: {[PR]: gh({checks: ["passing"]})}, running: (key) => key === KEY});
  await f.tick();
  assert.deepEqual([f.reads, f.wakes], [[], []]);
  assert.equal((await f.entry()).dueAt, T0 - 1);
  f.running = () => false;
  await f.tick();
  assert.equal(f.wakes.length, 1);
});

test("one failing entry does not stop the others", async () => {
  const f = await rig({entries: {[KEY]: {dueAt: T0 - 1, reason: "a"}, [OTHER_KEY]: {dueAt: T0 - 1, reason: "b"}}});
  f.wakeError = new Error("rejected");
  f.wakeFor = KEY;
  await f.tick();
  assert.deepEqual(f.wakes.map((wake) => wake.sessionKey), [OTHER_KEY]);
  assert.deepEqual(f.faults.map((fault) => fault.sessionKey), [KEY]);
  assert.equal((await f.entry(KEY)).dueAt, T0 - 1);
  assert.equal((await f.entry(OTHER_KEY)).dueAt, undefined);
});

test("expired entries are removed silently, with no read and no wake", async () => {
  const f = await rig({
    entries: {
      [KEY]: {createdAt: T0 - 30 * DAY, lastActivityAt: T0 - DAY, dueAt: T0 - 1, prs: {[PR]: fp()}},
      [OTHER_KEY]: {createdAt: T0 - 8 * DAY, lastActivityAt: T0 - 7 * DAY, dueAt: T0 - 1},
    },
  });
  await f.tick();
  assert.deepEqual([f.reads, f.wakes, f.faults], [[], [], []]);
  assert.deepEqual(await f.checkBacks.list(), []);
});

test("state recorded during a wake is not lost: a newer deadline and a newly linked PR survive", async () => {
  const f = await rig({entries: {[KEY]: {dueAt: T0 - 1, reason: "old"}}});
  await runCheckBackTick({
    checkBacks: f.checkBacks, now: T0, isRunning: () => false, read: async () => gh(), fault: async () => {},
    wake: async () => {
      await f.checkBacks.setDeadline(KEY, HOUR, "newer");
      await f.checkBacks.notePullRequests(KEY, PR_2);
    },
  });
  const entry = await f.entry();
  assert.equal(entry.reason, "newer");
  assert.equal(entry.dueAt, T0 + HOUR);
  assert.ok(PR_2 in entry.prs);
});

// ── Lifecycle events ────────────────────────────────────────────────────────

test("the first run end arms one 30-minute deadline; later run ends do not re-arm", async () => {
  const f = await rig();
  await f.checkBacks.noteRunEnd(KEY);
  let entry = await f.entry();
  assert.equal(entry.dueAt, T0 + 30 * MIN);
  assert.equal(entry.reason, "first check-back");
  assert.equal(entry.firstRunEnded, true);

  await f.checkBacks.update(KEY, (current) => { const {dueAt, reason, ...rest} = current; return rest; });
  f.now = T0 + HOUR;
  await f.checkBacks.noteRunEnd(KEY);
  entry = await f.entry();
  assert.equal(entry.dueAt, undefined);
  assert.equal(entry.lastActivityAt, T0 + HOUR);
});

test("a deadline the thread already set is not replaced by the first run end", async () => {
  const f = await rig({entries: {[KEY]: {dueAt: T0 + 2 * HOUR, reason: "mine"}}});
  await f.checkBacks.noteRunEnd(KEY);
  assert.deepEqual([(await f.entry()).dueAt, (await f.entry()).reason], [T0 + 2 * HOUR, "mine"]);
});

test("a run that a check-back started never arms a deadline or counts as activity", async () => {
  const f = await rig();
  f.now = T0 + HOUR;
  await f.checkBacks.noteRunEnd(KEY, {wokenByCheckBack: true});
  const entry = await f.entry();
  assert.deepEqual([entry.dueAt, entry.firstRunEnded, entry.lastActivityAt], [undefined, false, T0]);
});

test("pull requests sent in the thread are watched: new ones only, at most ten, registered threads only", async () => {
  const f = await rig();
  await f.checkBacks.notePullRequests(KEY, `see ${PR} and ${PR}, also ${PR_2}/files`);
  assert.deepEqual(Object.keys((await f.entry()).prs), [PR, PR_2]);
  await f.checkBacks.update(KEY, (entry) => ({...entry, prs: {...entry.prs, [PR]: fp("OPEN", "passing")}}));
  await f.checkBacks.notePullRequests(KEY, PR);
  assert.deepEqual((await f.entry()).prs[PR], fp("OPEN", "passing"), "a known PR keeps its record");

  const many = Array.from({length: 15}, (_, index) => `https://github.com/example/repo/pull/${100 + index}`);
  await f.checkBacks.notePullRequests(KEY, many.join(" "));
  assert.equal(Object.keys((await f.entry()).prs).length, CHECK_BACK.maxPullRequests);

  await f.checkBacks.notePullRequests("agent:max:slack:channel:c999:thread:1790050400.000009", PR);
  assert.equal((await f.checkBacks.list()).length, 1, "an unregistered thread is not created by a message");
});

test("closing a thread removes its entry, and a failed removal is journaled without failing the close", async () => {
  const f = await rig();
  const faults = [];
  const hooks = new Map();
  const lifecycle = registerHostClose({config: {channels: {slack: {accounts: {max: {}}}}}, on: (name, fn) => hooks.set(name, fn), registerTool() {}}, {
    isExcludedChannel: () => false,
    recordRunLifecycle: async () => {},
    appendFaultJournal: async (entry) => faults.push(entry),
    resolveDataRoot: () => "/nonexistent",
    resolveSlackRuntimeModule: () => new URL("./host-close.test-accounts.mjs", import.meta.url).pathname,
    slackApi: async () => { throw new Error("slack down"); },
    checkBacks: f.checkBacks,
  });
  const route = {channel: "C123", threadId: "1790050400.000001"};
  await lifecycle.close({route, sessionKey: KEY, accountId: "max"});
  assert.equal(await f.entry(), undefined);

  const broken = registerHostClose({config: {}, on() {}, registerTool() {}}, {
    isExcludedChannel: () => false, recordRunLifecycle: async () => {}, appendFaultJournal: async (entry) => faults.push(entry),
    resolveDataRoot: () => "/nonexistent", resolveSlackRuntimeModule: () => "", slackApi: async () => { throw new Error("slack down"); },
    checkBacks: {remove: async () => { throw new Error("disk full"); }},
  });
  await broken.close({route, sessionKey: KEY, accountId: "max"});
  assert.ok(faults.some((fault) => /Check-back removal: Error: disk full/.test(fault.reason)));
});

test("the lifecycle reports a running turn for its thread only", async () => {
  const lifecycle = new ThreadLifecycle({record: async () => {}, report: async () => {}});
  assert.equal(lifecycle.isRunning(KEY), false);
  await lifecycle.start({sessionKey: KEY, runId: "r1"});
  assert.equal(lifecycle.isRunning(KEY), true);
  assert.equal(lifecycle.isRunning(OTHER_KEY), false);
  await lifecycle.end({sessionKey: KEY, runId: "r1"});
  assert.equal(lifecycle.isRunning(KEY), false);
  assert.equal(lifecycle.isRunning("agent:max:slack:direct:u1"), false);
});

// ── Registry ────────────────────────────────────────────────────────────────

test("the registry survives a reload from disk", async () => {
  const f = await rig({entries: {[KEY]: {dueAt: T0 + HOUR, reason: "later", prs: {[PR]: fp("OPEN", "passing")}}}});
  const reloaded = new CheckBacks({path: f.checkBacks.path, now: () => T0});
  const [entry] = await reloaded.list();
  assert.equal(entry.sessionKey, KEY);
  assert.equal(entry.dueAt, T0 + HOUR);
  assert.deepEqual(entry.prs[PR], fp("OPEN", "passing"));
  assert.deepEqual((await readdir(join(f.dir, "operations"))).sort(), ["check-backs.json"], "no temporary file is left behind");
});

test("concurrent writes are serialized and none is lost", async () => {
  const f = await rig({entries: {}});
  const keys = Array.from({length: 25}, (_, index) => `agent:max:slack:channel:c123:thread:1790050400.0000${String(10 + index)}`);
  await Promise.all(keys.map((key) => f.checkBacks.register(key)));
  const reloaded = new CheckBacks({path: f.checkBacks.path});
  assert.equal((await reloaded.list()).length, 25);
});

test("a failed write rejects and leaves the registry as it was", async () => {
  const dir = await mkdtemp(join(tmpdir(), "check-back-"));
  const blocked = new CheckBacks({path: join(dir, "check-backs.json"), now: () => T0});
  await chmod(dir, 0o500);
  try { await assert.rejects(blocked.register(KEY)); }
  finally { await chmod(dir, 0o700); }
  assert.deepEqual(await blocked.list(), []);
  await blocked.register(KEY);
  assert.equal((await blocked.list()).length, 1);
});

test("an unreadable registry is set aside with a warning and the registry starts empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "check-back-"));
  const path = join(dir, "check-backs.json");
  await writeFile(path, "{not json");
  const warnings = [];
  const checkBacks = new CheckBacks({path, now: () => T0, warn: (message) => warnings.push(message)});
  assert.deepEqual(await checkBacks.list(), []);
  assert.equal(warnings.length, 1);
  assert.equal(await readFile(`${path}.corrupt`, "utf8"), "{not json");
  await checkBacks.register(KEY);
  assert.equal((await new CheckBacks({path}).list()).length, 1);
});

// ── Tool ────────────────────────────────────────────────────────────────────

const toolContext = {messageChannel: "slack", sessionKey: KEY, agentAccountId: "max", assertInvocationCurrent: () => {}};

test("check_back sets a bounded deadline on the calling thread, creating its entry on demand", async () => {
  const f = await rig({entries: {}});
  const tool = checkBackTool(toolContext, {checkBacks: f.checkBacks});
  assert.equal(tool.name, "check_back");
  assert.deepEqual(tool.parameters.required, ["in", "reason"]);
  assert.match(tool.description, /instead of automations/);
  assert.match(tool.description, /one pending check/);

  const result = await tool.execute("call-1", {in: "45m", reason: "CI for the migration"});
  assert.equal(result.isError, undefined);
  const entry = await f.entry();
  assert.deepEqual([entry.dueAt, entry.reason, entry.lastActivityAt, entry.firstRunEnded], [T0 + 45 * MIN, "CI for the migration", T0, true]);
});

test("check_back replaces the pending check and keeps the thread's watched PRs", async () => {
  const f = await rig({entries: {[KEY]: {dueAt: T0 + HOUR, reason: "old", prs: {[PR]: fp("OPEN", "passing")}}}});
  f.now = T0 + 10 * MIN;
  await checkBackTool(toolContext, {checkBacks: f.checkBacks}).execute("call-2", {in: "2h", reason: "new"});
  const entry = await f.entry();
  assert.deepEqual([entry.dueAt, entry.reason, entry.lastActivityAt], [T0 + 10 * MIN + 2 * HOUR, "new", T0 + 10 * MIN]);
  assert.deepEqual(entry.prs[PR], fp("OPEN", "passing"));
  assert.equal((await f.checkBacks.list()).length, 1);
});

test("check_back rejects out-of-bounds times and bad reasons without writing", async () => {
  const f = await rig({entries: {}});
  const tool = checkBackTool(toolContext, {checkBacks: f.checkBacks});
  const bad = [{in: "4m", reason: "x"}, {in: "25h", reason: "x"}, {in: "later", reason: "x"}, {in: "1h", reason: ""}, {in: "1h", reason: "x".repeat(301)}, {in: "1h"}];
  for (const args of bad) {
    const result = await tool.execute("call-3", args);
    assert.equal(result.isError, true, JSON.stringify(args).slice(0, 40));
  }
  assert.match((await tool.execute("call-4", {in: "25h", reason: "x"})).content[0].text, /between 5 minutes and 24 hours/);
  assert.equal((await tool.execute("call-5", {in: "1h", reason: "x".repeat(300)})).isError, undefined);
  assert.equal((await f.checkBacks.list()).length, 1);
});

test("a stale invocation is refused before anything is written", async () => {
  const f = await rig({entries: {}});
  const context = {...toolContext, assertInvocationCurrent: () => { throw new Error("stale invocation"); }};
  const result = await checkBackTool(context, {checkBacks: f.checkBacks}).execute("call-6", {in: "1h", reason: "x"});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /stale invocation/);
  assert.deepEqual(await f.checkBacks.list(), []);
});

test("the session key comes from the tool context, never from arguments", async () => {
  const f = await rig({entries: {}});
  await checkBackTool(toolContext, {checkBacks: f.checkBacks}).execute("call-7", {in: "1h", reason: "x", sessionKey: OTHER_KEY});
  assert.deepEqual((await f.checkBacks.list()).map((entry) => entry.sessionKey), [KEY]);
});

test("check_back exists only on Slack thread sessions", async () => {
  const f = await rig({entries: {}});
  for (const context of [
    {...toolContext, messageChannel: "webchat"},
    {...toolContext, sessionKey: "agent:max:slack:direct:u1"},
    {...toolContext, sessionKey: "agent:max:slack:channel:c123"},
    {...toolContext, sessionKey: "agent:max:subagent:worker-1"},
    {...toolContext, sessionKey: undefined},
  ]) assert.equal(checkBackTool(context, {checkBacks: f.checkBacks}), undefined);
});

// ── Plugin wiring ───────────────────────────────────────────────────────────

test("wiring: messages feed the registry, the service wakes the thread through the session run, and a woken run arms nothing", async () => {
  const f = await rig({entries: {[KEY]: {}}});
  const hooks = new Map(), tools = [], services = [], jobs = [], runs = [], faults = [];
  const clock = {now: T0};
  const checkBacks = new CheckBacks({path: f.checkBacks.path, now: () => clock.now});
  registerCheckBack({
    on: (name, fn) => hooks.set(name, fn),
    registerTool: (factory, options) => tools.push({factory, options}),
    registerService: (service) => services.push(service),
    runtime: {subagent: {run: async (params) => { runs.push(params); return {runId: "wake-run", sessionKey: params.sessionKey}; }}},
  }, {
    checkBacks,
    lifecycle: {isRunning: () => false},
    appendFaultJournal: async (entry) => faults.push(entry),
    read: async () => gh({state: "MERGED", checks: ["passing"]}),
  });
  assert.equal(tools[0].options.name, "check_back");
  assert.equal(tools[0].factory.contextVersion, 2);
  assert.equal(services[0].apiVersion, 2);
  services[0].start({scheduler: {now: () => clock.now, schedule: (job) => { jobs.push(job); return {}; }}});
  assert.deepEqual([jobs[0].everyMs, jobs[0].delayMs], [CHECK_BACK.tickMs, CHECK_BACK.tickMs]);

  await hooks.get("message_sent")({success: true, content: `PR: ${PR}`, sessionKey: KEY}, {});
  await hooks.get("message_sent")({success: false, content: PR_2, sessionKey: KEY}, {});
  await hooks.get("agent_end")({runId: "run-1"}, {sessionKey: KEY});
  let entry = (await checkBacks.list())[0];
  assert.deepEqual(Object.keys(entry.prs), [PR]);
  assert.equal(entry.dueAt, T0 + 30 * MIN);

  clock.now = T0 + 31 * MIN;
  await jobs[0].run();
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0].sessionKey, runs[0].deliver], [KEY, false]);
  assert.match(runs[0].idempotencyKey, /\S/);
  assert.match(runs[0].message, /first check-back/);
  assert.match(runs[0].message, /MERGED/);
  assert.equal((await checkBacks.list())[0], undefined, "the only PR merged and no deadline is pending, so the entry ended");

  await checkBacks.register(KEY);
  await hooks.get("agent_end")({runId: "wake-run"}, {sessionKey: KEY});
  entry = (await checkBacks.list())[0];
  assert.deepEqual([entry.dueAt, entry.firstRunEnded], [undefined, false]);
  assert.deepEqual(faults, []);
});

test("wiring: a registry failure on a hook is journaled, never thrown into the gateway", async () => {
  const hooks = new Map(), faults = [];
  registerCheckBack({on: (name, fn) => hooks.set(name, fn)}, {
    checkBacks: {notePullRequests: async () => { throw new Error("disk full"); }, noteRunEnd: async () => { throw new Error("disk full"); }},
    lifecycle: {isRunning: () => false},
    appendFaultJournal: async (entry) => faults.push(entry),
  });
  await hooks.get("message_sent")({success: true, content: PR, sessionKey: KEY}, {});
  await hooks.get("agent_end")({runId: "r"}, {sessionKey: KEY});
  assert.equal(faults.length, 2);
});
