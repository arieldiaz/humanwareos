import assert from "node:assert/strict";
import test from "node:test";
import {JEV_LIMITS, planBatches, scoreWithJev} from "./jev.mjs";
import {buildPack} from "./pack.mjs";
import {egressView, unitText, UNIT_CHARS} from "./privacy.mjs";

const SECRET = "RAW-CONVERSATION-SENTINEL";
const session = (id, patch = {}) => ({_id: id, kind: "session", title: `Slack thread #ops: ${SECRET} title`, meta: {agent: "liv", surface: "slack", channel: "#ops", date: "2026-09-29", label: "Build: status tiles", tools: ["exec×3"], files: ["docs/reply-shape.md"], rootText: SECRET}, localText: `user said ${SECRET}`, sourceRef: {sessionId: SECRET}, ...patch});
const pr = (n) => ({_id: `pr:x#${n}`, kind: "pr", title: `#${n}`, meta: {number: n, title: `PR ${n}`, description: "d".repeat(50)}, localText: ""});

function recorder(respond = (request) => ({answers: Object.fromEntries(Object.keys(request.questions).map((key) => [key, {type: "noul", noul: 0.9}])), usage: {input_tokens: 10, output_tokens: 2, cost: 0.001}})) {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(init.body);
    const body = await respond(JSON.parse(init.body));
    return {ok: true, status: 200, json: async () => body};
  };
  return {bodies, fetchImpl};
}

test("metadata egress is an allowlist: no raw text, root excerpt, source ref, or Slack ids", async () => {
  const doc = session("session:liv:1", {meta: {...session("x").meta, label: "thread C0BJSBM4XSR 1790716078.189609 done"}});
  const view = egressView(doc);
  assert.deepEqual(Object.keys(view), ["kind", "agent", "surface", "channel", "date", "label", "tools", "files"]);
  assert.equal(view.label, "thread [id] [ts] done");
  assert.equal(egressView({kind: "decision", meta: {summary: "DOCUMENTATION and CONVERSATION stay"}}).summary, "DOCUMENTATION and CONVERSATION stay");
  const {bodies, fetchImpl} = recorder();
  await scoreWithJev({goal: "g", docs: [doc], apiKey: "k", fetchImpl});
  assert.equal(bodies.length, 1);
  assert.ok(!bodies[0].includes(SECRET));
  assert.ok(!bodies[0].includes("C0BJSBM4XSR") && !bodies[0].includes("1790716078"));
  assert.ok(!bodies[0].includes("session:liv:1"), "document ids stay local; records are addressed by batch index");
});

test("full egress is explicit and bounded, which proves the metadata test can see raw text", async () => {
  const {bodies, fetchImpl} = recorder();
  await scoreWithJev({goal: "g", docs: [session("s", {localText: `${SECRET} ${"x".repeat(5000)}`})], mode: "full", apiKey: "k", fetchImpl});
  assert.ok(bodies[0].includes(SECRET));
  assert.ok(JSON.parse(bodies[0]).state.records[0].text.length <= UNIT_CHARS);
  assert.throws(() => egressView(session("s"), {mode: "everything"}), /invalid egress mode/);
  assert.throws(() => egressView({kind: "transcript", meta: {}}), /no egress view/);
});

test("planBatches bounds units, characters, and requests without reordering", () => {
  const units = Array.from({length: 300}, (_, i) => ({id: i, text: "x".repeat(i % 2 ? 900 : 100)}));
  const {batches, overflow} = planBatches(units);
  assert.equal(batches.length, JEV_LIMITS.maxRequests);
  for (const batch of batches) {
    assert.ok(batch.length <= JEV_LIMITS.batchUnits);
    assert.ok(batch.reduce((n, unit) => n + unit.text.length, 0) <= JEV_LIMITS.batchChars);
  }
  assert.deepEqual([...batches.flat(), ...overflow].map((unit) => unit.id), units.map((unit) => unit.id));
  assert.equal(planBatches([]).batches.length, 0);
});

test("request count and body size stay bounded for the largest candidate set", async () => {
  const docs = Array.from({length: 200}, (_, i) => session(`s${i}`, {meta: {...session("x").meta, files: Array.from({length: 40}, (_, j) => `path/${"f".repeat(80)}/${j}`)}}));
  const {bodies, fetchImpl} = recorder();
  const {scores, usage} = await scoreWithJev({goal: "g", docs, apiKey: "k", fetchImpl});
  assert.ok(bodies.length <= JEV_LIMITS.maxRequests);
  assert.equal(usage.requests, bodies.length);
  for (const body of bodies) assert.ok(Buffer.byteLength(body) <= JEV_LIMITS.bodyBytes);
  const overflow = [...scores.values()].filter((score) => score.reason === "overflow");
  assert.equal(overflow.length + [...scores.values()].filter((score) => score.status === "scored").length, 200);
});

test("malformed, missing, and out-of-range probabilities fail keep", async () => {
  const docs = [pr(1), pr(2), pr(3), pr(4), pr(5)];
  const {fetchImpl} = recorder(() => ({answers: {keep_0: {noul: 0.05}, keep_1: {noul: "0.9"}, keep_2: {noul: 1.7}, keep_3: {}}, usage: {}}));
  const {scores, usage} = await scoreWithJev({goal: "g", docs, apiKey: "k", fetchImpl});
  assert.deepEqual(docs.map((doc) => scores.get(doc._id).status), ["scored", "unscored", "unscored", "unscored", "unscored"]);
  assert.equal(usage.unknownUsageRequests, 1);
  const pack = buildPack({candidates: docs, scores});
  assert.deepEqual(pack.kept.map((item) => item.id), ["pr:x#2", "pr:x#3", "pr:x#4", "pr:x#5"]);
  assert.deepEqual(pack.dropped.map((item) => item.id), ["pr:x#1"]);
});

test("HTTP errors, network failures, and a missing key leave every candidate kept", async () => {
  for (const fetchImpl of [async () => ({ok: false, status: 503, json: async () => ({})}), async () => { throw new TypeError("fetch failed"); }, async () => ({ok: true, status: 200, json: async () => { throw new SyntaxError("bad json"); }})]) {
    const {scores, usage} = await scoreWithJev({goal: "g", docs: [pr(1), pr(2)], apiKey: "k", fetchImpl});
    assert.ok([...scores.values()].every((score) => score.status === "unscored"));
    assert.equal(usage.failedRequests, 1);
    assert.equal(buildPack({candidates: [pr(1), pr(2)], scores}).kept.length, 2);
  }
  const {scores} = await scoreWithJev({goal: "g", docs: [pr(1)], apiKey: undefined, fetchImpl: () => assert.fail("no request without a key")});
  assert.equal(scores.get("pr:x#1").reason, "not_configured");
});

test("pack keeps at most 15, orders scored keeps by probability, and lists every other id", () => {
  const candidates = Array.from({length: 40}, (_, i) => pr(i));
  const scores = new Map(candidates.map((doc, i) => [doc._id, i < 20 ? {p: i / 20, status: "scored"} : {p: null, status: "unscored", reason: "overflow"}]));
  const pack = buildPack({candidates, scores});
  assert.equal(pack.kept.length, 15);
  assert.deepEqual(pack.kept.slice(0, 3).map((item) => item.p), [0.95, 0.9, 0.85]);
  assert.equal(pack.kept.length + pack.dropped.length, 40);
  assert.ok(pack.dropped.every((item) => typeof item.id === "string"));
});

test("unit text is bounded", () => {
  assert.ok(unitText(egressView(pr(1), {mode: "metadata"})).length <= UNIT_CHARS);
  assert.ok(unitText({kind: "pr", description: "y".repeat(10000)}).length <= UNIT_CHARS);
});
