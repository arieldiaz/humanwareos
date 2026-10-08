#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// Required values with no generic default are validated in main() so the
// pure projection helpers stay importable for tests.
const DATA_ROOT = process.env.HUMANWARE_DATA_ROOT || null;
const INPUT_PATH = process.env.SLACK_THREAD_SUMMARY_INPUT
  || (DATA_ROOT ? path.join(DATA_ROOT, "generated/sessions/current.json") : null);
const OUTPUT_PATH = process.env.SLACK_THREAD_SUMMARY_OUTPUT
  || (DATA_ROOT ? path.join(DATA_ROOT, "generated/reports/slack-thread-summaries/latest.json") : null);
const CHANNEL_ID = process.env.SLACK_THREAD_SUMMARY_CHANNEL || null;
const MAX_INPUT_AGE_MS = Number(process.env.SLACK_THREAD_SUMMARY_MAX_AGE_MS ?? 21_600_000);
const PRODUCER = process.env.SLACK_THREAD_SUMMARY_PRODUCER || "humanwareos/slack-thread-summary@1";
// IANA zone for the message date; unset uses the host's local zone.
const TIME_ZONE = process.env.SLACK_THREAD_SUMMARY_TIMEZONE || undefined;

export function missingRequiredConfig({ dryRun = false } = {}) {
  const missing = [];
  if (!INPUT_PATH) missing.push("HUMANWARE_DATA_ROOT or SLACK_THREAD_SUMMARY_INPUT");
  if (!OUTPUT_PATH) missing.push("HUMANWARE_DATA_ROOT or SLACK_THREAD_SUMMARY_OUTPUT");
  if (!dryRun && !CHANNEL_ID) missing.push("SLACK_THREAD_SUMMARY_CHANNEL");
  return missing;
}

export const STATES = ["active", "clarify", "act", "scheduled"];

export function lifecycleForSession(session) {
  if (!session?.channelId || !session?.threadId) return null;
  if (session.status === "completed") return null;
  const workflow = session.workflow ?? {};
  if (workflow.state === "completed") return null;
  if (workflow.state === "scheduled" || workflow.emoji === "calendar") return "scheduled";
  if (workflow.state === "needs_you") {
    return workflow.emoji === "raised_hand" ? "act" : "clarify";
  }
  if (workflow.state === "active" || workflow.emoji === "arrows_counterclockwise") return "active";
  return null;
}

export function buildProjection(input, now = new Date()) {
  if (!input || !Array.isArray(input.sessions)) throw new Error("input sessions array is required");
  const sourceGeneratedAt = new Date(input.generatedAt);
  if (Number.isNaN(sourceGeneratedAt.getTime())) throw new Error("input generatedAt is invalid");
  const ageMs = now.getTime() - sourceGeneratedAt.getTime();
  if (ageMs < 0 || ageMs > MAX_INPUT_AGE_MS) {
    throw new Error(`input is stale: generatedAt=${input.generatedAt} ageMs=${ageMs}`);
  }
  const counts = Object.fromEntries(STATES.map((state) => [state, 0]));
  let earliestActivityAt = null;
  let latestActivityAt = null;
  for (const session of input.sessions) {
    const state = lifecycleForSession(session);
    if (!state) continue;
    counts[state] += 1;
    const activity = session.updatedAt ?? null;
    if (activity && (!earliestActivityAt || activity < earliestActivityAt)) earliestActivityAt = activity;
    if (activity && (!latestActivityAt || activity > latestActivityAt)) latestActivityAt = activity;
  }
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    producer: PRODUCER,
    source: {
      path: INPUT_PATH,
      schemaVersion: input.schemaVersion ?? null,
      generatedAt: input.generatedAt,
      earliestActivityAt,
      latestActivityAt,
    },
    counts,
    totalOpen: Object.values(counts).reduce((sum, count) => sum + count, 0),
  };
}

export function renderMessage(projection, date = new Date(projection.generatedAt)) {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    month: "short",
    day: "numeric",
  }).format(date);
  const { counts } = projection;
  return [
    `*Open Slack threads · ${day}*`,
    `🔄 *${counts.active}*  ·  ❓ *${counts.clarify}*  ·  ✋ *${counts.act}*  ·  🗓️ *${counts.scheduled}*`,
  ].join("\n");
}

async function publish(token, text) {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel: CHANNEL_ID, text, unfurl_links: false, unfurl_media: false }),
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(`delivery failed: ${body.error ?? response.status}`);
  return body;
}

async function main() {
  const dryRun = process.env.SLACK_THREAD_SUMMARY_DRY_RUN === "1";
  const token = process.env.SLACK_BOT_TOKEN;
  const missing = missingRequiredConfig({ dryRun });
  if (missing.length) throw new Error(`missing required configuration: ${missing.join(", ")}`);
  if (!dryRun && !token) throw new Error("SLACK_BOT_TOKEN is required");
  const input = JSON.parse(fs.readFileSync(INPUT_PATH, "utf8"));
  const projection = buildProjection(input);
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  const temporary = `${OUTPUT_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(projection, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, OUTPUT_PATH);
  const delivered = dryRun
    ? { ok: true, channel: CHANNEL_ID, ts: null, dryRun: true }
    : await publish(token, renderMessage(projection));
  process.stdout.write(`${JSON.stringify({
    event: "slack_thread_summary_completed",
    declarationKey: "slack-thread-status-audit",
    executable: process.argv[1],
    input: INPUT_PATH,
    output: OUTPUT_PATH,
    generatedAt: projection.generatedAt,
    sourceGeneratedAt: projection.source.generatedAt,
    totalOpen: projection.totalOpen,
    delivery: { ok: true, channel: delivered.channel, ts: delivered.ts, dryRun },
  })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      event: "slack_thread_summary_failed",
      declarationKey: "slack-thread-status-audit",
      executable: process.argv[1],
      errorClass: error?.constructor?.name ?? "Error",
      error: error.message,
      delivery: { ok: false },
    })}\n`);
    process.exitCode = 1;
  });
}
