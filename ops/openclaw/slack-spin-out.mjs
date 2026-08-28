#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function createSlackWorkThread({ accountId, agentId, channel, goal, detail, send }) {
  if (!accountId || !agentId || !channel || !goal || !detail) {
    throw new Error("accountId, agentId, channel, goal, and detail are required");
  }
  const root = await send({
    accountId,
    agentId,
    channel: "slack",
    to: `channel:${channel}`,
    message: `Goal: ${goal}`,
    topLevel: true,
    idempotencyKey: `slack-spin-out:${agentId}:${channel}:${crypto.randomUUID()}:root`,
  });
  if (!root?.messageId) throw new Error("Slack root send returned no messageId");
  const reply = await send({
    accountId,
    agentId,
    channel: "slack",
    to: `channel:${channel}`,
    message: detail,
    threadId: String(root.messageId),
    idempotencyKey: `slack-spin-out:${agentId}:${channel}:${root.messageId}:detail`,
  });
  if (!reply?.messageId) throw new Error("Slack detail reply returned no messageId");
  return { rootMessageId: String(root.messageId), replyMessageId: String(reply.messageId) };
}

async function gatewaySend(params) {
  const { stdout } = await execFileAsync(
    "openclaw",
    ["gateway", "call", "send", "--params", JSON.stringify(params), "--json"],
    { timeout: 60_000, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, "");
    const value = argv[index + 1];
    if (!key || value === undefined) throw new Error(`invalid argument: ${argv[index] ?? ""}`);
    args[key] = value;
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const result = await createSlackWorkThread({
    accountId: args.account,
    agentId: args.agent,
    channel: args.channel,
    goal: args.goal,
    detail: args.detail,
    send: gatewaySend,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
