import {createHash, randomBytes, randomUUID} from "node:crypto";
import {mkdirSync} from "node:fs";
import {dirname} from "node:path";
import {DatabaseSync} from "node:sqlite";

const json = (value) => JSON.stringify(value);
const parse = (value) => value ? JSON.parse(value) : null;
const recurrenceKey = (value) => value ? json(value) : "";
const boundaryValue = (boundary) => boundary.kind === "date" ? boundary.date : boundary.dateTime;
const tokenHash = (token) => createHash("sha256").update(token).digest("hex");

export class SqliteCalendarStore {
  constructor(path) {
    mkdirSync(dirname(path), {recursive: true});
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS calendars (
        id TEXT PRIMARY KEY, owner_address TEXT NOT NULL, revision INTEGER NOT NULL,
        default_for_inbound INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL,
        body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_default_calendar_per_bot
        ON calendars(owner_address) WHERE default_for_inbound = 1 AND state = 'active';
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, calendar_id TEXT NOT NULL REFERENCES calendars(id), uid TEXT NOT NULL,
        recurrence_key TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL, status TEXT NOT NULL,
        start_value TEXT NOT NULL, end_value TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
        body TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(calendar_id, uid, recurrence_key)
      );
      CREATE INDEX IF NOT EXISTS event_range ON events(calendar_id, start_value, end_value);
      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY, result TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL, actor TEXT NOT NULL,
        action TEXT NOT NULL, object_type TEXT NOT NULL, object_id TEXT NOT NULL,
        reason TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS feed_grants (
        id TEXT PRIMARY KEY, calendar_id TEXT NOT NULL REFERENCES calendars(id), token_hash TEXT UNIQUE NOT NULL,
        label TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS inbound_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL, recipient TEXT NOT NULL,
        status TEXT NOT NULL, event_id TEXT, diagnostic TEXT, payload TEXT, received_at TEXT NOT NULL,
        UNIQUE(message_id, recipient)
      );
    `);
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = callback(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  async list({calendarId, from = "", to = "9999", includeCancelled = false} = {}) {
    const rows = this.db.prepare(`SELECT body FROM events WHERE calendar_id = ? AND deleted = 0 AND end_value > ? AND start_value < ? ${includeCancelled ? "" : "AND status != 'cancelled'"} ORDER BY start_value, id`).all(calendarId, from, to);
    return rows.map((row) => parse(row.body));
  }
  async read(id, {includeDeleted = false} = {}) {
    const row = this.db.prepare(`SELECT body FROM events WHERE id = ? ${includeDeleted ? "" : "AND deleted = 0"}`).get(id);
    return parse(row?.body);
  }
  async readByUid(calendarId, uid, recurrenceId = null) {
    const row = this.db.prepare("SELECT body FROM events WHERE calendar_id = ? AND uid = ? AND recurrence_key = ? AND deleted = 0").get(calendarId, uid, recurrenceKey(recurrenceId));
    return parse(row?.body);
  }
  async claimOperation(operationId) {
    return parse(this.db.prepare("SELECT result FROM operations WHERE operation_id = ?").get(operationId)?.result);
  }
  async commit(event, context) {
    const result = {...event, audit: {operationId: context.policy.operationId, actor: context.policy.actor, reason: context.policy.reason, action: context.action}};
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO events(id, calendar_id, uid, recurrence_key, revision, status, start_value, end_value, deleted, body, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, status=excluded.status, start_value=excluded.start_value,
        end_value=excluded.end_value, deleted=0, body=excluded.body, updated_at=excluded.updated_at`).run(
        result.id, result.calendarId, result.uid, recurrenceKey(result.recurrenceId), result.revision, result.status,
        boundaryValue(result.start), boundaryValue(result.end), json(result), result.updatedAt);
      this.recordOperation(context.policy.operationId, result, context.now);
      this.recordAudit(context.policy, context.action, "event", result.id, result.revision, context.now);
      return result;
    });
  }
  async tombstone(event, context) {
    const result = {...event, revision: event.revision + 1, deleted: true, updatedAt: context.now, audit: {operationId: context.policy.operationId, actor: context.policy.actor, reason: context.policy.reason, action: "delete"}};
    return this.transaction(() => {
      this.db.prepare("UPDATE events SET revision = ?, deleted = 1, body = ?, updated_at = ? WHERE id = ?").run(result.revision, json(result), result.updatedAt, result.id);
      this.recordOperation(context.policy.operationId, result, context.now);
      this.recordAudit(context.policy, "delete", "event", result.id, result.revision, context.now);
      return result;
    });
  }
  recordOperation(operationId, result, now) {
    this.db.prepare("INSERT INTO operations(operation_id, result, created_at) VALUES(?, ?, ?)").run(operationId, json(result), now);
  }
  recordAudit(policy, action, objectType, objectId, revision, now) {
    this.db.prepare("INSERT INTO audit(operation_id, actor, action, object_type, object_id, reason, revision, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)").run(policy.operationId, policy.actor, action, objectType, objectId, policy.reason, revision, now);
  }

  listCalendars({ownerAddress} = {}) {
    const rows = ownerAddress
      ? this.db.prepare("SELECT body FROM calendars WHERE owner_address = ? AND state = 'active' ORDER BY created_at").all(ownerAddress.toLowerCase())
      : this.db.prepare("SELECT body FROM calendars WHERE state = 'active' ORDER BY created_at").all();
    return rows.map((row) => parse(row.body));
  }
  readCalendar(id) { return parse(this.db.prepare("SELECT body FROM calendars WHERE id = ? AND state = 'active'").get(id)?.body); }
  defaultCalendar(ownerAddress) { return parse(this.db.prepare("SELECT body FROM calendars WHERE owner_address = ? AND default_for_inbound = 1 AND state = 'active'").get(ownerAddress.toLowerCase())?.body); }
  createCalendar(calendar, policy) {
    const replay = this.db.prepare("SELECT result FROM operations WHERE operation_id = ?").get(policy.operationId);
    if (replay) return {...parse(replay.result), idempotentReplay: true};
    return this.transaction(() => {
      this.db.prepare("INSERT INTO calendars(id, owner_address, revision, default_for_inbound, state, body, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)").run(calendar.id, calendar.ownerAddress, calendar.revision, calendar.defaultForInbound ? 1 : 0, calendar.state, json(calendar), calendar.createdAt, calendar.updatedAt);
      this.recordOperation(policy.operationId, calendar, calendar.updatedAt);
      this.recordAudit(policy, "create", "calendar", calendar.id, calendar.revision, calendar.updatedAt);
      return calendar;
    });
  }
  createFeed(calendarId, label, policy, now = new Date().toISOString()) {
    const replay = this.db.prepare("SELECT result FROM operations WHERE operation_id = ?").get(policy.operationId);
    if (replay) return {...parse(replay.result), idempotentReplay: true};
    const token = randomBytes(32).toString("base64url");
    const grant = {id: randomUUID(), calendarId, label, createdBy: policy.actor, createdAt: now, token};
    return this.transaction(() => {
      this.db.prepare("INSERT INTO feed_grants(id, calendar_id, token_hash, label, created_by, created_at) VALUES(?, ?, ?, ?, ?, ?)").run(grant.id, calendarId, tokenHash(token), label, policy.actor, now);
      this.recordOperation(policy.operationId, grant, now);
      this.recordAudit(policy, "create", "feed_grant", grant.id, 1, now);
      return grant;
    });
  }
  resolveFeed(token) {
    const row = this.db.prepare("SELECT calendar_id FROM feed_grants WHERE token_hash = ? AND revoked_at IS NULL").get(tokenHash(token));
    return row?.calendar_id ?? null;
  }
  recordInbound({messageId, recipient, status, eventId = null, diagnostic = null, payload = null, receivedAt = new Date().toISOString()}) {
    this.db.prepare("INSERT INTO inbound_messages(message_id, recipient, status, event_id, diagnostic, payload, received_at) VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(message_id, recipient) DO UPDATE SET status=excluded.status, event_id=excluded.event_id, diagnostic=excluded.diagnostic, payload=excluded.payload").run(messageId, recipient, status, eventId, diagnostic, payload ? json(payload) : null, receivedAt);
  }
  listInbound({recipients, recipient, status} = {}) {
    const allowed = recipient ? [recipient.toLowerCase()] : recipients;
    if (!allowed?.length) return [];
    const placeholders = allowed.map(() => "?").join(",");
    const rows = this.db.prepare(`SELECT message_id, recipient, status, event_id, diagnostic, payload, received_at FROM inbound_messages WHERE recipient IN (${placeholders}) ${status ? "AND status = ?" : ""} ORDER BY received_at DESC LIMIT 100`).all(...allowed, ...(status ? [status] : []));
    return rows.map((row) => ({messageId: row.message_id, recipient: row.recipient, status: row.status, eventId: row.event_id, diagnostic: row.diagnostic, receivedAt: row.received_at, ...parse(row.payload)}));
  }
  dashboard() {
    return {calendars: this.listCalendars(), events: this.db.prepare("SELECT body FROM events WHERE deleted = 0 ORDER BY start_value, id").all().map((row) => parse(row.body))};
  }
}
