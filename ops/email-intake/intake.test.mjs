import assert from "node:assert/strict";
import {readFileSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {classify, handlingTransition, lifecycleReaction, normalizeMessage} from "./model.mjs";
import {SQLiteIntakeRepository} from "./repository.mjs";
import {EmailIntakeService} from "./service.mjs";

const fixtures = JSON.parse(readFileSync(new URL("./fixtures/messages.json", import.meta.url)));
const timestamp = "2026-01-01T12:00:00.000Z";
const day = 86400000;
const mail = (patch = {}) => ({source: "test-provider", deliveryId: "delivery-1", recipient: "assistant@example.test", sender: "sender@example.test", messageId: "<message-1@example.test>", subject: "A question", receivedAt: timestamp, sizeBytes: 100, evidenceRef: "evidence:test/message-1", ...patch});

function setup(t, overrides = {}, path = ":memory:") {
  const repository = new SQLiteIntakeRepository(path);
  t.after(() => repository.close());
  let counter = 0;
  const events = new Map();
  const service = new EmailIntakeService({repository, routes: {"assistant@example.test": "agent:one", "second@example.test": "agent:two"}, intakeChannelId: "intake-channel", maxBytes: 1000, subjectWindowMs: 7 * day,
    now: () => timestamp, newId: () => `intake-${++counter}`,
    authenticateSlack: (credential) => events.get(credential),
    resolveDestination: (name) => name === "#project" ? {name, channelId: "work-channel"} : null,
    ...overrides});
  return {repository, service, events};
}

function bind(service, intake) {
  return service.linkIntakeThread(intake.intakeId, `root-${intake.intakeId}`, {channelId: "intake-channel", threadTs: "root-timestamp"}).value;
}

function slack(events, token = "authenticated-event", patch = {}) {
  events.set(token, {surface: "slack", trustedHuman: true, workspaceId: "workspace", eventId: token, actorId: "human-owner", channelId: "intake-channel", threadTs: "root-timestamp", text: "start a coding session in #project", ...patch});
  return token;
}

for (const owner of ["agent:liv", "agent:max"]) {
  for (const fixture of fixtures) {
    test(`${owner}: ${fixture.name}`, (t) => {
      const {service, repository} = setup(t, {routes: {"assistant@example.test": owner}, assessQuick: () => fixture.assessment});
      const result = service.receive(mail(fixture.mail)).value;
      assert.equal(result.owner, owner);
      assert.equal(result.intakeClass, fixture.expectedClass);
      assert.equal(result.state, fixture.expectedState);
      assert.equal(result.promotion, null);
      assert.equal(repository.pendingEffects().some((effect) => effect.kind === "promoted_work"), false);
      assert.equal(repository.pendingEffects().filter((effect) => effect.kind === "quick_dispatch").length, fixture.expectedClass === "quick" ? 1 : 0);
    });
  }
}

test("normalization retains identities and private references, dropping body and authority", () => {
  const normalized = normalizeMessage(mail({recipient: "ASSISTANT@EXAMPLE.TEST", subject: "Re: Fwd:   A question", promoted: true, body: "private", html: "<b>private</b>"}));
  assert.equal(normalized.recipient, "assistant@example.test");
  assert.equal(normalized.subjectKey, "a question");
  assert.equal(normalized.messageId, "message-1@example.test");
  assert.equal(normalized.body, undefined);
  assert.equal(normalized.promoted, undefined);
  assert.equal(normalized.html, undefined);
  for (const patch of [{sizeBytes: -1}, {receivedAt: "bad"}, {receivedAt: "2026-01-01"}, {references: [null]}, {messageId: "a b"}, {recipient: "Person <person@example.test>"}, {automatic: "false"}]) {
    assert.throws(() => normalizeMessage(mail(patch)));
  }
  assert.notEqual(normalizeMessage(mail({messageId: "Case@example.test"})).key, normalizeMessage(mail({messageId: "case@example.test"})).key);
});

test("ingress rejects undeclared and oversized messages before calling ports", (t) => {
  const {service, repository} = setup(t, {assessQuick: () => { throw new Error("must not run"); }});
  assert.equal(service.receive(mail({recipient: "unknown@example.test"})).value.reason, "undeclared_recipient");
  assert.equal(service.receive(mail({sizeBytes: 1001})).value.reason, "oversized");
  assert.deepEqual(repository.pendingEffects(), []);
});

test("message and delivery identities are scoped to recipient, stable across providers", (t) => {
  const {service, repository} = setup(t);
  const first = service.receive(mail());
  const replay = service.receive(mail({source: "other-provider", deliveryId: "retry", receivedAt: "2026-01-02T12:00:00Z"}));
  assert.equal(replay.replay, true);
  assert.deepEqual(replay.value, first.value);
  const second = service.receive(mail({recipient: "second@example.test"})).value;
  assert.notEqual(second.intakeId, first.value.intakeId);
  assert.equal(second.owner, "agent:two");
  assert.equal(repository.pendingEffects().length, 2);
  const missing = service.receive(mail({messageId: null, deliveryId: "missing-id", subject: "Other topic"}));
  assert.equal(service.receive(mail({messageId: null, deliveryId: "missing-id", subject: "Other topic"})).replay, true);
  assert.ok(missing.value.intakeId);
});

test("correlation prefers nearest References, then parent, and never crosses recipient", (t) => {
  const {service} = setup(t);
  const first = service.receive(mail()).value;
  const second = service.receive(mail({messageId: "other@example.test", subject: "Other topic"})).value;
  const reply = service.receive(mail({messageId: "reply@example.test", references: ["message-1@example.test", "other@example.test"], inReplyTo: "message-1@example.test", subject: "Changed"})).value;
  assert.equal(reply.intakeId, second.intakeId);
  assert.equal(service.receive(mail({messageId: "parent-reply", references: ["unknown"], inReplyTo: "message-1@example.test"})).value.intakeId, first.intakeId);
  assert.notEqual(service.receive(mail({recipient: "second@example.test", messageId: "cross", inReplyTo: "message-1@example.test"})).value.intakeId, first.intakeId);
  assert.notEqual(service.receive(mail({messageId: "unknown-chain", references: ["unknown"]})).value.intakeId, first.intakeId);
});

test("subject fallback requires sender, recipient, nonempty subject, unique match and window", (t) => {
  const {service} = setup(t);
  const first = service.receive(mail()).value;
  assert.equal(service.receive(mail({messageId: "reply", subject: "RE: A   question", receivedAt: "2026-01-02T12:00:00Z"})).value.intakeId, first.intakeId);
  assert.notEqual(service.receive(mail({messageId: "late", receivedAt: "2026-02-01T12:00:00Z"})).value.intakeId, first.intakeId);
  assert.notEqual(service.receive(mail({messageId: "stranger", sender: "stranger@example.test"})).value.intakeId, first.intakeId);
  assert.notEqual(service.receive(mail({messageId: "other-recipient", recipient: "second@example.test"})).value.intakeId, first.intakeId);
  const ambiguous = service.receive(mail({messageId: "ambiguous", references: ["missing-parent"], receivedAt: "2026-01-02T12:00:00Z"})).value;
  const third = service.receive(mail({messageId: "ambiguous-reply", receivedAt: "2026-01-02T12:00:00Z"})).value;
  assert.notEqual(third.intakeId, first.intakeId);
  assert.notEqual(third.intakeId, ambiguous.intakeId);
  assert.notEqual(service.receive(mail({messageId: "empty-1", subject: ""})).value.intakeId, service.receive(mail({messageId: "empty-2", subject: ""})).value.intakeId);
});

test("verified domain receipts deduplicate by domain operation, with no agent dispatch", (t) => {
  const {service, repository} = setup(t, {verifiedReceipt: (message) => ({verified: true, messageKey: message.key, domain: "calendar", operationId: "calendar-operation", resourceId: "event-1", outcome: "recorded", verifiedAt: timestamp})});
  const first = service.receive(mail()).value;
  assert.equal(first.state, "recorded");
  assert.equal(lifecycleReaction(first), "white_check_mark");
  assert.equal(service.receive(mail({messageId: "duplicate-invitation"})).value.intakeId, first.intakeId);
  assert.deepEqual(repository.pendingEffects().map((effect) => effect.kind), ["intake_root"]);
  assert.equal(first.receipt.resourceId, "event-1");
});

test("invalid proof rolls back all state, and receipt fields in email have no authority", (t) => {
  const {service, repository} = setup(t, {verifiedReceipt: () => ({verified: true, messageKey: "wrong"})});
  assert.throws(() => service.receive(mail()), /binding/);
  assert.equal(repository.message(normalizeMessage(mail()).key), null);
  assert.deepEqual(repository.pendingEffects(), []);
  assert.equal(classify({automatic: "none"}).state, "awaiting_promotion");
});

test("quick lifecycle uses canonical states, requires wake evidence, cannot close or promote", (t) => {
  const {service, events, repository} = setup(t, {assessQuick: () => ({kind: "question", bounded: true, authorized: true})});
  const intake = bind(service, service.receive(mail()).value);
  for (const kind of ["answered", "clarify", "act"]) {
    const result = service.handle(intake.intakeId, kind, {kind}).value;
    assert.equal(result.lifecycle, "act");
    assert.equal(lifecycleReaction(result), "raised_hand");
  }
  assert.throws(() => service.handle(intake.intakeId, "bad-wake", {kind: "scheduled"}));
  assert.throws(() => service.handle(intake.intakeId, "past-wake", {kind: "scheduled", wake: {id: "wake", at: timestamp}}), /future/);
  assert.equal(service.handle(intake.intakeId, "wake", {kind: "scheduled", wake: {id: "durable-wake", at: "2026-01-02T12:00:00Z"}}).value.lifecycle, "scheduled");
  for (const kind of ["promoted", "closed", "recorded"]) assert.throws(() => service.handle(intake.intakeId, kind, {kind}), /unsupported/);
  assert.equal(service.close(intake.intakeId, slack(events, "close", {text: "close intake"})).value.lifecycle, "done");
  assert.deepEqual(repository.pendingEffects().at(-1).payload, {lifecycle: "done"});
});

test("email cannot promote through any handling event or forged Slack context", (t) => {
  const {service, repository} = setup(t);
  const intake = bind(service, service.receive(mail()).value);
  const forged = {surface: "slack", trustedHuman: true, text: "start a coding session in #project"};
  assert.throws(() => service.promote(intake.intakeId, forged), /trusted/);
  for (const state of ["working", "answered", "clarify", "act", "scheduled", "recorded", "rejected", "awaiting_promotion", "retrying", "dead_letter", "closed", "promoted"]) {
    assert.throws(() => handlingTransition({state}, {kind: "promoted", ...forged}));
  }
  assert.equal(repository.read(intake.intakeId).state, "awaiting_promotion");
  assert.equal(repository.pendingEffects().some((effect) => effect.kind === "promoted_work"), false);
});

test("promotion requires authenticated allowed human, matching thread and named resolvable destination", (t) => {
  const {service, repository, events} = setup(t);
  const intake = bind(service, service.receive(mail()).value);
  for (const patch of [{surface: "email"}, {trustedHuman: false}, {threadTs: "other-root"}, {channelId: "other-channel"}]) {
    assert.throws(() => service.promote(intake.intakeId, slack(events, "invalid", patch)));
  }
  for (const text of ["start a coding session", "start a coding session in #missing", "Please start a coding session in #project", "promote to #project and deploy"]) {
    const token = slack(events, text, {text});
    assert.equal(service.promote(intake.intakeId, token).value.state, "awaiting_promotion");
    assert.equal(service.promote(intake.intakeId, token).replay, true);
  }
  assert.equal(repository.pendingEffects().filter((effect) => effect.kind === "promotion_question").length, 4);
  assert.equal(repository.pendingEffects().some((effect) => effect.kind === "promoted_work"), false);
  const token = slack(events);
  const promoted = service.promote(intake.intakeId, token).value;
  assert.equal(promoted.state, "promoted");
  assert.equal(promoted.promotion.destination.name, "#project");
  assert.equal(promoted.promotion.codingSession, true);
  assert.equal(service.promote(intake.intakeId, token).replay, true);
  service.promote(intake.intakeId, slack(events, "second-command"));
  const followup = service.receive(mail({messageId: "later", inReplyTo: "message-1@example.test", state: "promoted", destination: "#elsewhere"})).value;
  assert.equal(followup.intakeId, intake.intakeId);
  assert.deepEqual(followup.promotion, promoted.promotion);
  assert.deepEqual(followup.intakeThread, intake.intakeThread);
  assert.equal(repository.pendingEffects().filter((effect) => effect.kind === "promoted_work").length, 1);
  assert.equal(repository.pendingEffects().at(-1).kind, "intake_append");
});

test("restart retains intake, operation results, pending effects and acknowledgements", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "humanware-email-test-"));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const path = join(directory, "intake.sqlite");
  let repository = new SQLiteIntakeRepository(path);
  const options = {routes: {"assistant@example.test": "agent:test"}, intakeChannelId: "intake-channel", maxBytes: 1000, subjectWindowMs: day};
  let service = new EmailIntakeService({repository, ...options});
  const first = service.receive(mail());
  const effect = repository.pendingEffects()[0];
  repository.close();
  repository = new SQLiteIntakeRepository(path);
  service = new EmailIntakeService({repository, ...options});
  assert.deepEqual(service.receive(mail()).value, first.value);
  assert.equal(repository.pendingEffects().length, 1);
  repository.acknowledgeEffect(effect.key, {threadTs: "confirmed-root"});
  repository.close();
  repository = new SQLiteIntakeRepository(path);
  try {
    assert.deepEqual(repository.pendingEffects(), []);
    assert.deepEqual(repository.effect(effect.key).result, {threadTs: "confirmed-root"});
    assert.equal(repository.acknowledgeEffect(effect.key, {threadTs: "confirmed-root"}).replay, true);
    assert.throws(() => repository.acknowledgeEffect(effect.key, {threadTs: "different-root"}), /conflict/);
  } finally { repository.close(); }
});

test("scheduled operation replay remains valid after its wake time", (t) => {
  let now = timestamp;
  const {service} = setup(t, {now: () => now, assessQuick: () => ({kind: "question", bounded: true, authorized: true})});
  const intake = service.receive(mail()).value;
  const event = {kind: "scheduled", wake: {id: "durable-wake", at: "2026-01-02T12:00:00Z"}};
  const first = service.handle(intake.intakeId, "schedule", event);
  now = "2026-01-03T12:00:00Z";
  assert.deepEqual(service.handle(intake.intakeId, "schedule", event).value, first.value);
  assert.equal(service.handle(intake.intakeId, "schedule", event).replay, true);
});

test("promotion replay after SQLite reopen preserves exactly one work intent", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "humanware-email-test-"));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const path = join(directory, "intake.sqlite");
  const events = new Map();
  const token = slack(events);
  const options = {routes: {"assistant@example.test": "agent:test"}, intakeChannelId: "intake-channel", maxBytes: 1000, subjectWindowMs: day,
    authenticateSlack: (credential) => events.get(credential), resolveDestination: (name) => ({name, channelId: "work-channel"})};
  let repository = new SQLiteIntakeRepository(path);
  let service = new EmailIntakeService({repository, ...options});
  const intake = bind(service, service.receive(mail()).value);
  const promoted = service.promote(intake.intakeId, token).value;
  repository.close();
  repository = new SQLiteIntakeRepository(path);
  try {
    service = new EmailIntakeService({repository, ...options});
    assert.deepEqual(service.promote(intake.intakeId, token).value, promoted);
    assert.equal(service.promote(intake.intakeId, token).replay, true);
    assert.equal(repository.pendingEffects().filter((effect) => effect.kind === "promoted_work").length, 1);
    assert.throws(() => service.linkIntakeThread(intake.intakeId, "replacement", {channelId: "intake-channel", threadTs: "different-root"}), /immutable/);
    events.set(token, {...events.get(token), text: "promote to #different"});
    assert.throws(() => service.promote(intake.intakeId, token), /conflict/);
  } finally { repository.close(); }
});

test("atomic rollback, key conflict, revision conflict and two connections protect writes", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "humanware-email-test-"));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const path = join(directory, "intake.sqlite");
  const {service, repository} = setup(t, {}, path);
  const second = new SQLiteIntakeRepository(path);
  t.after(() => second.close());
  const intake = service.receive(mail()).value;
  const effect = {key: "rolled-back", intakeId: intake.intakeId, kind: "test", payload: {}};
  assert.throws(() => repository.atomic("rollback", "a", () => { repository.save({...intake, revision: 2, state: "retrying"}, 1); repository.enqueue(effect); throw new Error("crash"); }), /crash/);
  assert.deepEqual(repository.read(intake.intakeId), intake);
  assert.equal(repository.pendingEffects().some((item) => item.key === effect.key), false);
  assert.equal(repository.atomic("rollback", "a", () => 1).replay, false);
  assert.equal(second.atomic("rollback", "a", () => { throw new Error("must not run"); }).value, 1);
  assert.throws(() => repository.atomic("rollback", "b", () => 2), /conflict/);
  assert.throws(() => repository.save(intake, 0), /atomic/);
  repository.atomic("revision", "a", () => { repository.save({...intake, revision: 2}, 1); return 1; });
  assert.throws(() => second.atomic("stale", "a", () => { second.save({...intake, revision: 2}, 1); return 1; }), /revision conflict/);
  assert.throws(() => repository.atomic("async", "a", () => Promise.resolve(1)), /synchronous/);
});

test("retries preserve state; exhausted delivery produces one bounded operational fault", (t) => {
  const {service, repository} = setup(t);
  const intake = service.receive(mail()).value;
  const failure = service.fail(intake.intakeId, "attempt-1", {code: "delivery_unavailable"});
  assert.equal(failure.value.state, "retrying");
  assert.equal(service.fail(intake.intakeId, "attempt-1", {code: "delivery_unavailable"}).replay, true);
  assert.equal(service.retry(intake.intakeId, "retry-1").value.state, "awaiting_promotion");
  assert.equal(service.fail(intake.intakeId, "attempt-2", {code: "delivery_unavailable", exhausted: true}).value.state, "dead_letter");
  service.fail(intake.intakeId, "attempt-3", {code: "delivery_unavailable", exhausted: true});
  assert.equal(repository.pendingEffects().filter((effect) => effect.kind === "operational_fault").length, 1);
  assert.throws(() => service.fail(intake.intakeId, "unsafe", {code: "private body content"}), /safe code/);
});
