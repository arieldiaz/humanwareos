import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";

import {
  createThreadOwnershipRuntime,
  decideThreadOwner,
  inferThreadOwnerFromMessages,
  mentionedAgentAccounts,
  threadOwnerKey,
} from "./thread-ownership.mjs";

const accounts = {liv: "U0LIV123", max: "U0MAX123"};

test("extracts configured agent mentions in message order", () => {
  assert.deepEqual(mentionedAgentAccounts("<@U0LIV123> please, cc <@U0MAX123>", accounts), ["liv", "max"]);
});

test("the first mentioned agent owns follow-ups while other explicit mentions get one turn", () => {
  assert.deepEqual(decideThreadOwner({accountId: "liv", mentionedAccounts: ["liv", "max"]}), {
    allow: true,
    nextOwner: "liv",
    reason: "explicit-agent-mention",
  });
  assert.deepEqual(decideThreadOwner({accountId: "max", mentionedAccounts: ["liv", "max"]}), {
    allow: true,
    nextOwner: "liv",
    reason: "explicit-agent-mention",
  });
  assert.equal(decideThreadOwner({accountId: "liv", currentOwner: "liv", mentionedAccounts: []}).allow, true);
  assert.equal(decideThreadOwner({accountId: "max", currentOwner: "liv", mentionedAccounts: []}).allow, false);
});

test("a single explicit mention transfers ownership", () => {
  assert.deepEqual(decideThreadOwner({accountId: "max", currentOwner: "liv", mentionedAccounts: ["max"]}), {
    allow: true,
    nextOwner: "max",
    reason: "explicit-agent-mention",
  });
});

test("an existing unclaimed thread fails quiet until an agent is explicitly selected", () => {
  assert.deepEqual(decideThreadOwner({accountId: "liv", mentionedAccounts: []}), {
    allow: false,
    reason: "thread-owner-not-established",
  });
});

test("an old thread inherits the most recent configured agent author", () => {
  assert.equal(inferThreadOwnerFromMessages([
    {user: "U1", text: "question"},
    {user: "U0MAX123", text: "older Max answer"},
    {user: "U1", text: "follow-up"},
    {user: "U0LIV123", text: "latest Liv answer"},
  ], accounts), "liv");
});

test("ownership scope can be recovered from hook context", () => {
  assert.equal(threadOwnerKey(
    {isGroup: true, threadId: "100"},
    {channelId: "slack", conversationId: "C1"},
  ), "slack:c1:100");
});

test("claims persist and suppress the non-owner before dispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "thread-owner-test-"));
  const path = join(dir, "owners.jsonl");
  const runtime = createThreadOwnershipRuntime({accounts, path});
  const root = {channel: "slack", isGroup: true, conversationId: "C1", messageId: "100", content: "<@U0LIV123> hi <@U0MAX123>"};
  assert.deepEqual(await runtime.claim({...root, accountId: "liv"}), {handled: false, owner: "liv", reason: "explicit-agent-mention"});
  assert.deepEqual(await runtime.claim({...root, accountId: "max"}), {handled: false, owner: "liv", reason: "explicit-agent-mention"});
  const followup = {channel: "slack", isGroup: true, conversationId: "C1", threadId: "100", messageId: "101", content: "follow up"};
  assert.deepEqual(await runtime.claim({...followup, accountId: "liv"}), {handled: false, owner: "liv", reason: "thread-owner"});
  assert.deepEqual(await runtime.claim({...followup, accountId: "max"}), {handled: true, owner: "liv", reason: "different-thread-owner"});
  assert.match(await readFile(path, "utf8"), /"owner":"liv"/);
  assert.equal(threadOwnerKey(followup), "slack:c1:100");
});
