#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const DATA_ROOT = process.env.HUMANWARE_DATA_ROOT || null;
const INPUT_PATH = process.env.SLACK_NOTION_INPUT
  || (DATA_ROOT ? path.join(DATA_ROOT, "generated/sessions/current.json") : null);
const RECORDS_ROOT = process.env.SLACK_NOTION_RECORDS_ROOT
  || (DATA_ROOT ? path.join(DATA_ROOT, "generated/sessions") : null);
const STATE_PATH = process.env.SLACK_NOTION_STATE
  || (DATA_ROOT ? path.join(DATA_ROOT, "operations/slack-notion-sync/state.json") : null);
const SUMMARY_BASE_URL = (process.env.SLACK_NOTION_SUMMARY_BASE_URL || "").replace(/\/$/, "");
const NOTION_DATA_SOURCE_ID = process.env.NOTION_DATA_SOURCE_ID || null;
const NOTION_API_VERSION = process.env.NOTION_API_VERSION || "2026-03-11";
const MAX_INPUT_AGE_MS = Number(process.env.SLACK_NOTION_MAX_INPUT_AGE_MS ?? 300_000);
const FULL_SYNC_INTERVAL_MS = Number(process.env.SLACK_NOTION_FULL_SYNC_INTERVAL_MS ?? 21_600_000);

const STATUS_BY_REACTION = {
  arrows_counterclockwise: "🔄 Working",
  question: "❓ Clarify",
  raised_hand: "✋ Act",
  calendar: "🗓️ Scheduled",
  white_check_mark: "✅ Closed",
  warning: "⚠️ Error",
};
const GLYPH_BY_REACTION = {
  eyes: "👀",
  thumbsup: "👍",
  "+1": "👍",
  tada: "🎉",
  heart: "❤️",
  fire: "🔥",
};

export function missingRequiredConfig({ dryRun = false } = {}) {
  const missing = [];
  if (!INPUT_PATH) missing.push("HUMANWARE_DATA_ROOT or SLACK_NOTION_INPUT");
  if (!RECORDS_ROOT) missing.push("HUMANWARE_DATA_ROOT or SLACK_NOTION_RECORDS_ROOT");
  if (!STATE_PATH) missing.push("HUMANWARE_DATA_ROOT or SLACK_NOTION_STATE");
  if (!SUMMARY_BASE_URL) missing.push("SLACK_NOTION_SUMMARY_BASE_URL");
  if (!NOTION_DATA_SOURCE_ID) missing.push("NOTION_DATA_SOURCE_ID");
  if (!dryRun && !process.env.SLACK_BOT_TOKEN) missing.push("SLACK_BOT_TOKEN");
  if (!dryRun && !process.env.NOTION_TOKEN) missing.push("NOTION_TOKEN");
  return missing;
}

function decodeEntities(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function titleFromSlackText(text, limit = 80) {
  const cleaned = decodeEntities(String(text || ""))
    .replace(/<@[A-Z0-9]+(?:\|[^>]+)?>/gi, " ")
    .replace(/<![^>]+>/g, " ")
    .replace(/<#[A-Z0-9]+(?:\|[^>]+)?>/gi, " ")
    .replace(/<https?:\/\/[^>|]+(?:\|([^>]+))?>/gi, (_match, label) => label ? ` ${label} ` : " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[\n\r\t]+/g, " ")
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "Untitled Slack thread";
  if (cleaned.length <= limit) return cleaned;
  return cleaned.slice(0, limit).trimEnd();
}

export function statusFromRoot(root) {
  const name = root?.reactions?.[0]?.name;
  if (!name) return null;
  if (STATUS_BY_REACTION[name]) return STATUS_BY_REACTION[name];
  const word = name.split(/[_-]+/).filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ") || name;
  return `${GLYPH_BY_REACTION[name] || `:${name}:`} ${word}`;
}

export function isoFromSlackTs(ts) {
  const seconds = Number(ts);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

function formatDuration(milliseconds) {
  let minutes = Math.max(0, Math.round(Number(milliseconds || 0) / 60_000));
  const hours = Math.floor(minutes / 60);
  minutes %= 60;
  if (hours && minutes) return `${hours}h ${minutes}m`;
  if (hours) return `${hours}h`;
  if (minutes) return `${minutes}m`;
  return "<1m";
}

function moneyForSession(session) {
  let total = 0;
  let unavailable = 0;
  let currency = null;
  for (const item of session.spend || []) {
    unavailable += Number(item.unavailable || 0);
    total += Number(item.exact || 0) + Number(item.estimated || 0);
    currency ||= item.currency || null;
  }
  if (unavailable && total === 0) return "$—";
  if (currency && currency !== "USD") return `${currency} ${total.toFixed(2)}`;
  return `$${total.toFixed(2)}`;
}

export function sessionStats(session, replyCount, record = {}) {
  const details = Array.isArray(record.details) ? record.details : [];
  const runs = new Set(details.map((item) => item.runId).filter(Boolean));
  const fallbackRuns = new Set((session.events || []).map((item) => item.runId).filter(Boolean));
  const count = runs.size || fallbackRuns.size || 1;
  const sessionMessages = details.filter((item) => ["message", "prompt.submitted", "model.completed"].includes(item.type)).length;
  const messages = sessionMessages || Number(replyCount || 0) + 1;
  return `${count} session${count === 1 ? "" : "s"} · ${messages} msg${messages === 1 ? "" : "s"} · ${formatDuration(session.runtimeMs)} · ${moneyForSession(session)}`;
}

function textProperty(value) {
  return { rich_text: value ? [{ type: "text", text: { content: String(value) } }] : [] };
}

function titleProperty(value) {
  return { title: [{ type: "text", text: { content: value } }] };
}

function dateProperty(value) {
  return { date: value ? { start: value } : null };
}

export function notionProperties(row, previous = null, now = new Date().toISOString()) {
  const previousStatus = previous?.status ?? null;
  const statusChanged = row.status === previousStatus
    ? previous?.statusChanged ?? null
    : row.statusChanged || now;
  return {
    Title: titleProperty(row.title),
    Status: { select: row.status ? { name: row.status } : null },
    "Slack link": { url: row.slackLink },
    Channel: { select: row.channel ? { name: row.channel } : null },
    "Channel ID": textProperty(row.channelId),
    Started: dateProperty(row.started),
    "Last activity": dateProperty(row.lastActivity),
    Replies: { number: row.replies },
    "Status changed": dateProperty(statusChanged),
    "Session stats": textProperty(row.sessionStats),
    "Session summary": { url: row.sessionSummary },
    "Thread key": textProperty(row.threadKey),
  };
}

function propertyText(property) {
  return (property?.rich_text || property?.title || []).map((item) => item.plain_text || "").join("");
}

export function existingRowFromPage(page) {
  const properties = page.properties || {};
  return {
    pageId: page.id,
    threadKey: propertyText(properties["Thread key"]),
    status: properties.Status?.select?.name ?? null,
    statusChanged: properties["Status changed"]?.date?.start ?? null,
  };
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function atomicJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

async function apiJson(url, options, label) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, options);
    const body = await response.json();
    if (response.ok && body.ok !== false) return body;
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === 3) throw new Error(`${label} failed: ${body.message || body.error || response.status}`);
    const retryAfter = Math.min(10, Math.max(1, Number(response.headers.get("retry-after") || 2 ** attempt)));
    await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
  }
  throw new Error(`${label} failed after retries`);
}

async function slack(method, query = {}) {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return apiJson(url, { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } }, `Slack ${method}`);
}

async function notion(endpoint, { method = "GET", body } = {}) {
  return apiJson(`https://api.notion.com/v1/${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_API_VERSION,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, `Notion ${method} ${endpoint}`);
}

async function existingNotionRows() {
  const rows = new Map();
  let cursor = null;
  do {
    const page = await notion(`data_sources/${NOTION_DATA_SOURCE_ID}/query`, {
      method: "POST",
      body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
    });
    for (const result of page.results || []) {
      const row = existingRowFromPage(result);
      if (row.threadKey) rows.set(row.threadKey, row);
    }
    cursor = page.has_more ? page.next_cursor : null;
  } while (cursor);
  return rows;
}

async function notionSelectOptionWriter(propertyName) {
  const source = await notion(`data_sources/${NOTION_DATA_SOURCE_ID}`);
  const property = source.properties?.[propertyName];
  if (!property?.select) throw new Error(`Notion ${propertyName} property must be a select`);
  const options = (property.select.options || []).map((option) => ({
    name: option.name,
    color: option.color || "default",
  }));
  const names = new Set(options.map((option) => option.name));
  return async (name) => {
    if (!name || names.has(name)) return;
    options.push({ name, color: "default" });
    await notion(`data_sources/${NOTION_DATA_SOURCE_ID}`, {
      method: "PATCH",
      body: { properties: { [propertyName]: { select: { options } } } },
    });
    names.add(name);
  };
}

function statusChangedAt(session, status, now) {
  const expected = STATUS_BY_REACTION[session.workflow?.emoji];
  return status && expected === status ? session.workflow?.ts || now : now;
}

export async function buildRow(session, { channelCache = new Map(), now = new Date().toISOString() } = {}) {
  const response = await slack("conversations.replies", { channel: session.channelId, ts: session.threadId, limit: "1" });
  const root = response.messages?.[0];
  if (!root) throw new Error(`Slack root not found: ${session.channelId}:${session.threadId}`);
  let channel = channelCache.get(session.channelId);
  if (!channel) {
    const info = await slack("conversations.info", { channel: session.channelId });
    channel = info.channel?.name || session.channelId;
    channelCache.set(session.channelId, channel);
  }
  let slackLink = session.slackUrl;
  if (!slackLink) {
    const permalink = await slack("chat.getPermalink", { channel: session.channelId, message_ts: session.threadId });
    slackLink = permalink.permalink;
  }
  const record = session.record ? readJson(path.join(RECORDS_ROOT, session.record), {}) : {};
  const replyCount = Number(root.reply_count || 0);
  const status = statusFromRoot(root);
  const summaryName = path.basename(session.summaryMarkdown || (session.record || "").replace(/\.json$/, ".md"));
  return {
    title: titleFromSlackText(root.text),
    status,
    slackLink,
    channel,
    channelId: session.channelId,
    started: isoFromSlackTs(root.ts || session.threadId),
    lastActivity: isoFromSlackTs(root.latest_reply || root.ts || session.threadId),
    replies: replyCount,
    statusChanged: statusChangedAt(session, status, now),
    sessionStats: sessionStats(session, replyCount, record),
    sessionSummary: `${SUMMARY_BASE_URL}/${encodeURIComponent(summaryName)}`,
    threadKey: `${session.channelId}:${session.threadId}`,
  };
}

async function upsertRow(row, previous, now) {
  const properties = notionProperties(row, previous, now);
  if (previous?.pageId) {
    await notion(`pages/${previous.pageId}`, { method: "PATCH", body: { properties } });
    return "updated";
  }
  await notion("pages", {
    method: "POST",
    body: { parent: { type: "data_source_id", data_source_id: NOTION_DATA_SOURCE_ID }, properties },
  });
  return "created";
}

export function validateInput(input, now = new Date()) {
  if (!input || !Array.isArray(input.sessions)) throw new Error("input sessions array is required");
  const generatedAt = new Date(input.generatedAt);
  if (Number.isNaN(generatedAt.getTime())) throw new Error("input generatedAt is invalid");
  const age = now.getTime() - generatedAt.getTime();
  if (age < 0 || age > MAX_INPUT_AGE_MS) throw new Error(`input is stale: generatedAt=${input.generatedAt} ageMs=${age}`);
  return input.sessions.filter((session) => session.channelId && session.threadId);
}

async function main() {
  const dryRun = process.env.SLACK_NOTION_DRY_RUN === "1";
  const missing = missingRequiredConfig({ dryRun });
  if (missing.length) throw new Error(`missing required configuration: ${missing.join(", ")}`);
  const now = new Date();
  const sessions = validateInput(readJson(INPUT_PATH), now);
  if (dryRun) {
    process.stdout.write(`${JSON.stringify({ event: "slack_notion_sync_validated", sessions: sessions.length, input: INPUT_PATH })}\n`);
    return;
  }
  const state = readJson(STATE_PATH, { schemaVersion: 1, threads: {}, lastFullSyncAt: null });
  const existing = await existingNotionRows();
  const ensureChannelOption = await notionSelectOptionWriter("Channel");
  const ensureStatusOption = await notionSelectOptionWriter("Status");
  const fullSync = !state.lastFullSyncAt || now.getTime() - new Date(state.lastFullSyncAt).getTime() >= FULL_SYNC_INTERVAL_MS;
  const channelCache = new Map();
  const totals = { created: 0, updated: 0, skipped: 0, failed: 0 };
  for (const session of sessions) {
    const threadKey = `${session.channelId}:${session.threadId}`;
    const observed = state.threads[threadKey];
    if (!fullSync && existing.has(threadKey) && observed === session.updatedAt) {
      totals.skipped += 1;
      continue;
    }
    try {
      const row = await buildRow(session, { channelCache, now: now.toISOString() });
      await ensureChannelOption(row.channel);
      await ensureStatusOption(row.status);
      const result = await upsertRow(row, existing.get(threadKey), now.toISOString());
      totals[result] += 1;
      state.threads[threadKey] = session.updatedAt || now.toISOString();
    } catch (error) {
      totals.failed += 1;
      delete state.threads[threadKey];
      process.stderr.write(`${JSON.stringify({ event: "slack_notion_thread_failed", threadKey, error: error.message })}\n`);
    }
  }
  if (fullSync) state.lastFullSyncAt = now.toISOString();
  state.updatedAt = now.toISOString();
  atomicJson(STATE_PATH, state);
  process.stdout.write(`${JSON.stringify({ event: "slack_notion_sync_completed", input: INPUT_PATH, fullSync, ...totals })}\n`);
  if (totals.failed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ event: "slack_notion_sync_failed", error: error.message })}\n`);
    process.exitCode = 1;
  });
}
