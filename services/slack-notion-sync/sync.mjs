#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const DATA_ROOT = process.env.HUMANWARE_DATA_ROOT || null;
const INPUT_PATH = process.env.SLACK_NOTION_INPUT
  || (DATA_ROOT ? path.join(DATA_ROOT, "generated/sessions/current.json") : null);
const RECORDS_ROOT = process.env.SLACK_NOTION_RECORDS_ROOT
  || (DATA_ROOT ? path.join(DATA_ROOT, "generated/sessions") : null);
const STATE_PATH = process.env.SLACK_NOTION_STATE
  || (DATA_ROOT ? path.join(DATA_ROOT, "operations/slack-notion-sync/state.json") : null);
const EVENTS_PATH = process.env.SLACK_NOTION_EVENTS
  || (DATA_ROOT ? path.join(DATA_ROOT, "operations/slack-notion-sync/events.jsonl") : null);
const REVIEW_PATH = process.env.SLACK_NOTION_REVIEW
  || (DATA_ROOT ? path.join(DATA_ROOT, "operations/slack-notion-sync/manual-review.jsonl") : null);
const MIGRATION_BASELINE_PATH = process.env.SLACK_NOTION_MIGRATION_BASELINE
  || (DATA_ROOT ? path.join(DATA_ROOT, "operations/slack-notion-sync/migration-baseline.json") : null);
const SUMMARY_BASE_URL = (process.env.SLACK_NOTION_SUMMARY_BASE_URL || "").replace(/\/$/, "");
const NOTION_DATA_SOURCE_ID = process.env.NOTION_DATA_SOURCE_ID || null;
const NOTION_API_VERSION = process.env.NOTION_API_VERSION || "2026-03-11";
const MAX_INPUT_AGE_MS = Number(process.env.SLACK_NOTION_MAX_INPUT_AGE_MS ?? 300_000);
const FULL_SYNC_INTERVAL_MS = Number(process.env.SLACK_NOTION_FULL_SYNC_INTERVAL_MS ?? 21_600_000);
const NOTION_WRITE_DELAY_MS = Number(process.env.SLACK_NOTION_WRITE_DELAY_MS ?? 350);
const EVENT_DEBOUNCE_MS = Number(process.env.SLACK_NOTION_EVENT_DEBOUNCE_MS ?? 2_000);
const HUMAN_STATUS_ACTORS = new Set(String(process.env.SLACK_HUMAN_STATUS_ACTORS || "")
  .split(",").map((value) => value.trim()).filter(Boolean));

const STATUS_BY_REACTION = {
  arrows_counterclockwise: "🔄 Working",
  raised_hand: "✋ Act",
  hand: "✋ Act",
  calendar: "🗓️ Scheduled",
  white_check_mark: "✅ Closed",
};
const NON_MESSAGE_ROOT_SUBTYPES = new Set([
  "channel_archive",
  "channel_convert_to_public",
  "channel_join",
  "channel_leave",
  "channel_name",
  "channel_posting_permissions",
  "channel_purpose",
  "channel_topic",
  "channel_unarchive",
  "group_archive",
  "group_join",
  "group_leave",
  "group_name",
  "group_purpose",
  "group_topic",
  "group_unarchive",
  "message_deleted",
  "message_changed",
  "tabbed_canvas_updated",
  "tombstone",
]);

export function missingRequiredConfig({ dryRun = false } = {}) {
  const missing = [];
  if (!INPUT_PATH) missing.push("HUMANWARE_DATA_ROOT or SLACK_NOTION_INPUT");
  if (!RECORDS_ROOT) missing.push("HUMANWARE_DATA_ROOT or SLACK_NOTION_RECORDS_ROOT");
  if (!STATE_PATH) missing.push("HUMANWARE_DATA_ROOT or SLACK_NOTION_STATE");
  if (!EVENTS_PATH) missing.push("HUMANWARE_DATA_ROOT or SLACK_NOTION_EVENTS");
  if (!REVIEW_PATH) missing.push("HUMANWARE_DATA_ROOT or SLACK_NOTION_REVIEW");
  if (!SUMMARY_BASE_URL) missing.push("SLACK_NOTION_SUMMARY_BASE_URL");
  if (!NOTION_DATA_SOURCE_ID) missing.push("NOTION_DATA_SOURCE_ID");
  if (!HUMAN_STATUS_ACTORS.size) missing.push("SLACK_HUMAN_STATUS_ACTORS");
  if (!dryRun && !process.env.SLACK_BOT_TOKEN) missing.push("SLACK_BOT_TOKEN");
  if (!dryRun && !process.env.NOTION_TOKEN) missing.push("NOTION_TOKEN");
  return missing;
}

export function isMainModule(moduleUrl, entrypoint) {
  return Boolean(entrypoint) && moduleUrl === pathToFileURL(entrypoint).href;
}

export function isSlackMessageRoot(message) {
  return Boolean(message?.ts)
    && (!message.thread_ts || message.thread_ts === message.ts)
    && !NON_MESSAGE_ROOT_SUBTYPES.has(message.subtype);
}

export function slackPermalink(workspaceUrl, channelId, threadTs) {
  const base = String(workspaceUrl || "").replace(/\/$/, "");
  return `${base}/archives/${channelId}/p${String(threadTs).replace(".", "")}`;
}

export function rootFingerprint(channelName, root, status = statusFromRoot(root, HUMAN_STATUS_ACTORS)) {
  const relevant = {
    channelName,
    text: root.text || "",
    replyCount: Number(root.reply_count || 0),
    latestReply: root.latest_reply || root.ts,
    status,
  };
  return createHash("sha256").update(JSON.stringify(relevant)).digest("hex");
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

export function statusesFromRoot(root, actorIds = HUMAN_STATUS_ACTORS) {
  const names = new Set();
  for (const reaction of root?.reactions ?? []) {
    const canonical = reaction.name === "hand" ? "raised_hand" : reaction.name;
    if (!STATUS_BY_REACTION[canonical]) continue;
    if ((reaction.users ?? []).some((userId) => actorIds.has(userId))) names.add(canonical);
  }
  return [...names].sort();
}

export function statusFromRoot(root, actorIds = HUMAN_STATUS_ACTORS) {
  const statuses = statusesFromRoot(root, actorIds);
  return statuses.length === 1 ? STATUS_BY_REACTION[statuses[0]] : null;
}

export function migratedStatusForThread(threadKey, root, baselineStatuses = {}, migrationClaims = {}, actorIds = HUMAN_STATUS_ACTORS) {
  const statuses = statusesFromRoot(root, actorIds);
  if (statuses.length === 1) return STATUS_BY_REACTION[statuses[0]];
  if (statuses.length > 1 || migrationClaims[threadKey]) return null;
  return baselineStatuses[threadKey] ?? null;
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

export async function discoverSlackRoots(callSlack = slack) {
  const authentication = await callSlack("auth.test");
  const workspaceUrl = authentication.url;
  if (!workspaceUrl) throw new Error("Slack auth.test did not return a workspace URL");
  const channels = [];
  let cursor = null;
  do {
    const page = await callSlack("conversations.list", {
      types: "public_channel,private_channel",
      exclude_archived: "false",
      limit: "200",
      ...(cursor ? { cursor } : {}),
    });
    channels.push(...(page.channels || []).filter((channel) => channel.is_member));
    cursor = page.response_metadata?.next_cursor || null;
  } while (cursor);

  const roots = [];
  for (const channel of channels) {
    cursor = null;
    do {
      const page = await callSlack("conversations.history", {
        channel: channel.id,
        limit: "200",
        inclusive: "true",
        ...(cursor ? { cursor } : {}),
      });
      for (const root of page.messages || []) {
        if (!isSlackMessageRoot(root)) continue;
        roots.push({
          channelId: channel.id,
          channelName: channel.name || channel.id,
          root,
          slackLink: slackPermalink(workspaceUrl, channel.id, root.ts),
        });
      }
      cursor = page.response_metadata?.next_cursor || null;
    } while (cursor);
  }
  return { channels: channels.length, roots };
}

export async function discoverSlackRoot(channelId, threadTs, callSlack = slack) {
  const [authentication, channel, page] = await Promise.all([
    callSlack("auth.test"),
    callSlack("conversations.info", {channel: channelId}),
    callSlack("conversations.history", {
      channel: channelId,
      oldest: threadTs,
      latest: threadTs,
      inclusive: "true",
      limit: "1",
    }),
  ]);
  const root = (page.messages ?? []).find((message) => message.ts === threadTs);
  if (!root || !isSlackMessageRoot(root)) return null;
  return {
    channelId,
    channelName: channel.channel?.name || channelId,
    root,
    slackLink: slackPermalink(authentication.url, channelId, threadTs),
  };
}

export function pendingStatusEvents(text, state, now = new Date()) {
  const processed = state.processedEvents ?? {};
  const byThread = new Map();
  const source = String(text ?? "");
  const lines = source.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      if (index === lines.length - 1 && !source.endsWith("\n")) continue;
      throw error;
    }
    if (!event.id || processed[event.id] || !event.channelId || !event.messageTs) continue;
    const key = `${event.channelId}:${event.messageTs}`;
    const group = byThread.get(key) ?? [];
    group.push(event);
    byThread.set(key, group);
  }
  const ready = [];
  for (const [threadKey, events] of byThread) {
    events.sort((a, b) => String(a.observedAt).localeCompare(String(b.observedAt)));
    const latest = events.at(-1);
    const observedAt = new Date(latest.observedAt);
    if (Number.isNaN(observedAt.getTime()) || now.getTime() - observedAt.getTime() < EVENT_DEBOUNCE_MS) continue;
    ready.push({threadKey, event: latest, ids: [...new Set(events.map((event) => event.id))]});
  }
  return ready;
}

export function hasUnprocessedStatusEvents(text, state) {
  const processed = state.processedEvents ?? {};
  const source = String(text ?? "");
  const lines = source.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.id && !processed[event.id]) return true;
    } catch (error) {
      if (index === lines.length - 1 && !source.endsWith("\n")) continue;
      throw error;
    }
  }
  return false;
}

function readText(filePath, fallback = "") {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), {recursive: true, mode: 0o700});
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, {mode: 0o600});
}

let nextNotionWriteAt = 0;
async function notion(endpoint, { method = "GET", body } = {}) {
  const isWrite = method === "PATCH" || (method === "POST" && endpoint === "pages");
  if (isWrite && NOTION_WRITE_DELAY_MS > 0) {
    const wait = Math.max(0, nextNotionWriteAt - Date.now());
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    nextNotionWriteAt = Date.now() + NOTION_WRITE_DELAY_MS;
  }
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

async function existingNotionRow(threadKey) {
  const page = await notion(`data_sources/${NOTION_DATA_SOURCE_ID}/query`, {
    method: "POST",
    body: {
      page_size: 2,
      filter: {property: "Thread key", rich_text: {equals: threadKey}},
    },
  });
  if ((page.results ?? []).length > 1) throw new Error(`duplicate Notion Thread key: ${threadKey}`);
  return page.results?.[0] ? existingRowFromPage(page.results[0]) : null;
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

export function buildRowFromRoot(discovered, session = null, now = new Date().toISOString(), statusObservedAt = now, projectedStatus) {
  const { channelId, channelName, root, slackLink } = discovered;
  const record = session?.record ? readJson(path.join(RECORDS_ROOT, session.record), {}) : {};
  const replyCount = Number(root.reply_count || 0);
  const status = projectedStatus === undefined ? statusFromRoot(root) : projectedStatus;
  const summaryName = session
    ? path.basename(session.summaryMarkdown || (session.record || "").replace(/\.json$/, ".md"))
    : null;
  return {
    title: titleFromSlackText(root.text),
    status,
    slackLink,
    channel: channelName,
    channelId,
    started: isoFromSlackTs(root.ts),
    lastActivity: isoFromSlackTs(root.latest_reply || root.ts),
    replies: replyCount,
    statusChanged: statusObservedAt,
    sessionStats: session ? sessionStats(session, replyCount, record) : null,
    sessionSummary: summaryName ? `${SUMMARY_BASE_URL}/${encodeURIComponent(summaryName)}` : null,
    threadKey: `${channelId}:${root.ts}`,
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
    const discovered = process.env.SLACK_BOT_TOKEN ? await discoverSlackRoots() : null;
    process.stdout.write(`${JSON.stringify({
      event: "slack_notion_sync_validated",
      sessions: sessions.length,
      input: INPUT_PATH,
      channels: discovered?.channels ?? null,
      roots: discovered?.roots.length ?? null,
    })}\n`);
    return;
  }
  const state = readJson(STATE_PATH, { schemaVersion: 4, threads: {}, processedEvents: {}, ambiguities: {}, migrationClaims: {}, lastFullSyncAt: null });
  state.threads ??= {};
  state.processedEvents ??= {};
  state.ambiguities ??= {};
  state.migrationClaims ??= {};
  const migrationBaseline = MIGRATION_BASELINE_PATH
    ? readJson(MIGRATION_BASELINE_PATH, {schemaVersion: 1, statuses: {}, ambiguous: {}})
    : {schemaVersion: 1, statuses: {}, ambiguous: {}};
  const baselineStatuses = migrationBaseline?.statuses ?? {};
  const ensureChannelOption = await notionSelectOptionWriter("Channel");
  const ensureStatusOption = await notionSelectOptionWriter("Status");
  const fullSync = !state.lastFullSyncAt || now.getTime() - new Date(state.lastFullSyncAt).getTime() >= FULL_SYNC_INTERVAL_MS;
  const sessionByThread = new Map(sessions.map((session) => [
    `${session.channelId}:${session.threadId}`,
    session,
  ]));
  let eventText = readText(EVENTS_PATH);
  let pendingEvents = pendingStatusEvents(eventText, state, now);
  for (let attempt = 0; attempt < 3 && !pendingEvents.length && hasUnprocessedStatusEvents(eventText, state); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, EVENT_DEBOUNCE_MS));
    eventText = readText(EVENTS_PATH);
    pendingEvents = pendingStatusEvents(eventText, state, new Date());
  }
  const totals = { created: 0, updated: 0, skipped: 0, failed: 0 };
  if (pendingEvents.length) {
    for (const pending of pendingEvents) {
      try {
        state.migrationClaims[pending.threadKey] = pending.event.observedAt ?? now.toISOString();
        const item = await discoverSlackRoot(pending.event.channelId, pending.event.messageTs);
        if (!item) throw new Error("reaction target is not a Slack message root");
        const statuses = statusesFromRoot(item.root);
        if (statuses.length > 1) {
          const fingerprint = statuses.join(",");
          if (state.ambiguities[pending.threadKey] !== fingerprint) {
            appendJsonLine(REVIEW_PATH, {at: now.toISOString(), threadKey: pending.threadKey, statuses});
            state.ambiguities[pending.threadKey] = fingerprint;
          }
        } else {
          delete state.ambiguities[pending.threadKey];
        }
        const statusObservedAt = isoFromSlackTs(pending.event.eventTs) ?? pending.event.observedAt ?? now.toISOString();
        const status = migratedStatusForThread(pending.threadKey, item.root, baselineStatuses, state.migrationClaims);
        const row = buildRowFromRoot(item, sessionByThread.get(pending.threadKey), now.toISOString(), statusObservedAt, status);
        await ensureChannelOption(row.channel);
        await ensureStatusOption(row.status);
        const previous = await existingNotionRow(pending.threadKey);
        const result = await upsertRow(row, previous, now.toISOString());
        totals[result] += 1;
        state.threads[pending.threadKey] = {fingerprint: rootFingerprint(item.channelName, item.root, status)};
        for (const id of pending.ids) state.processedEvents[id] = now.toISOString();
      } catch (error) {
        totals.failed += 1;
        process.stderr.write(`${JSON.stringify({event: "slack_notion_event_failed", threadKey: pending.threadKey, error: error.message})}\n`);
      }
    }
  } else {
    const existing = await existingNotionRows();
    const discovered = await discoverSlackRoots();
    for (const item of discovered.roots) {
      const threadKey = `${item.channelId}:${item.root.ts}`;
      const humanStatuses = statusesFromRoot(item.root);
      if (humanStatuses.length && baselineStatuses[threadKey] && !state.migrationClaims[threadKey]) {
        state.migrationClaims[threadKey] = now.toISOString();
      }
      const status = migratedStatusForThread(threadKey, item.root, baselineStatuses, state.migrationClaims);
      const fingerprint = rootFingerprint(item.channelName, item.root, status);
      const observed = state.threads[threadKey];
      if (!fullSync && existing.has(threadKey) && observed?.fingerprint === fingerprint) {
        totals.skipped += 1;
        continue;
      }
      try {
        const row = buildRowFromRoot(item, sessionByThread.get(threadKey), now.toISOString(), now.toISOString(), status);
        await ensureChannelOption(row.channel);
        await ensureStatusOption(row.status);
        const result = await upsertRow(row, existing.get(threadKey), now.toISOString());
        totals[result] += 1;
        state.threads[threadKey] = { fingerprint };
      } catch (error) {
        totals.failed += 1;
        delete state.threads[threadKey];
        process.stderr.write(`${JSON.stringify({ event: "slack_notion_thread_failed", threadKey, error: error.message })}\n`);
      }
      if (humanStatuses.length > 1) {
        const fingerprint = humanStatuses.join(",");
        if (state.ambiguities[threadKey] !== fingerprint) {
          appendJsonLine(REVIEW_PATH, {at: now.toISOString(), threadKey, statuses: humanStatuses});
          state.ambiguities[threadKey] = fingerprint;
        }
      } else {
        delete state.ambiguities[threadKey];
      }
    }
    if (fullSync) state.lastFullSyncAt = now.toISOString();
    totals.channels = discovered.channels;
    totals.roots = discovered.roots.length;
  }
  const processedEntries = Object.entries(state.processedEvents).sort((a, b) => String(b[1]).localeCompare(String(a[1]))).slice(0, 10_000);
  state.processedEvents = Object.fromEntries(processedEntries);
  state.updatedAt = now.toISOString();
  state.schemaVersion = 4;
  atomicJson(STATE_PATH, state);
  process.stdout.write(`${JSON.stringify({ event: "slack_notion_sync_completed", input: INPUT_PATH, mode: pendingEvents.length ? "targeted" : "reconciliation", targeted: pendingEvents.length, fullSync, ...totals })}\n`);
  if (totals.failed) process.exitCode = 1;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ event: "slack_notion_sync_failed", error: error.message })}\n`);
    process.exitCode = 1;
  });
}
