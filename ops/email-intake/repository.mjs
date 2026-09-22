import {DatabaseSync} from "node:sqlite";

export function assertIntakeRepository(repository) {
  for (const method of ["atomic", "read", "save", "message", "addMessage", "byMessageId", "bySubject", "receipt", "addReceipt", "enqueue", "effect", "pendingEffects", "acknowledgeEffect"]) {
    if (typeof repository?.[method] !== "function") throw new Error(`intake repository must implement ${method}()`);
  }
  return repository;
}

/** Instance supplies the database path. All callbacks and transactions are synchronous. */
export class SQLiteIntakeRepository {
  #db;
  #writing = false;

  constructor(path) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS email_intake_conversations (
        id TEXT PRIMARY KEY, revision INTEGER NOT NULL, recipient TEXT NOT NULL,
        sender TEXT NOT NULL, subject_key TEXT NOT NULL, last_received_at TEXT NOT NULL, value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS email_intake_subject ON email_intake_conversations(recipient, sender, subject_key, last_received_at);
      CREATE TABLE IF NOT EXISTS email_intake_messages (
        key TEXT PRIMARY KEY, intake_id TEXT NOT NULL REFERENCES email_intake_conversations(id),
        recipient TEXT NOT NULL, message_id TEXT, value TEXT NOT NULL,
        UNIQUE(recipient, message_id)
      );
      CREATE TABLE IF NOT EXISTS email_intake_operations (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS email_intake_receipts (
        key TEXT PRIMARY KEY, intake_id TEXT NOT NULL REFERENCES email_intake_conversations(id), value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS email_intake_effects (
        key TEXT PRIMARY KEY, intake_id TEXT NOT NULL REFERENCES email_intake_conversations(id),
        kind TEXT NOT NULL, payload TEXT NOT NULL, result TEXT
      );
    `);
  }

  close() { this.#db.close(); }

  #requireTransaction() {
    if (!this.#writing) throw new Error("write requires atomic operation");
  }

  atomic(key, fingerprint, callback) {
    if (this.#writing) throw new Error("nested intake transaction");
    this.#db.exec("BEGIN IMMEDIATE");
    this.#writing = true;
    try {
      const prior = this.#db.prepare("SELECT * FROM email_intake_operations WHERE key = ?").get(key);
      if (prior && prior.fingerprint !== fingerprint) throw new Error("idempotency key conflict");
      const result = prior ? JSON.parse(prior.result) : callback();
      if (result === undefined || result?.then) throw new Error("atomic callback must return a synchronous JSON result");
      if (!prior) this.#db.prepare("INSERT INTO email_intake_operations VALUES (?, ?, ?)").run(key, fingerprint, JSON.stringify(result));
      this.#db.exec("COMMIT");
      return {value: result, replay: Boolean(prior)};
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    } finally { this.#writing = false; }
  }

  read(id) {
    const row = this.#db.prepare("SELECT value FROM email_intake_conversations WHERE id = ?").get(id);
    return row ? JSON.parse(row.value) : null;
  }

  save(conversation, expectedRevision) {
    this.#requireTransaction();
    if (conversation.revision !== expectedRevision + 1) throw new Error("invalid revision increment");
    const values = [conversation.revision, conversation.recipient, conversation.sender, conversation.subjectKey, conversation.lastReceivedAt, JSON.stringify(conversation)];
    if (expectedRevision === 0) {
      this.#db.prepare("INSERT INTO email_intake_conversations VALUES (?, ?, ?, ?, ?, ?, ?)").run(conversation.intakeId, ...values);
    } else {
      const result = this.#db.prepare("UPDATE email_intake_conversations SET revision=?, recipient=?, sender=?, subject_key=?, last_received_at=?, value=? WHERE id=? AND revision=?").run(...values, conversation.intakeId, expectedRevision);
      if (result.changes !== 1) throw new Error("conversation revision conflict");
    }
  }

  message(key) {
    const row = this.#db.prepare("SELECT * FROM email_intake_messages WHERE key = ?").get(key);
    return row ? {intakeId: row.intake_id, message: JSON.parse(row.value)} : null;
  }

  addMessage(message, intakeId) {
    this.#requireTransaction();
    this.#db.prepare("INSERT INTO email_intake_messages VALUES (?, ?, ?, ?, ?)").run(message.key, intakeId, message.recipient, message.messageId, JSON.stringify(message));
  }

  byMessageId(recipient, id) {
    const row = this.#db.prepare("SELECT intake_id FROM email_intake_messages WHERE recipient=? AND message_id=?").get(recipient, id);
    return row ? this.read(row.intake_id) : null;
  }

  bySubject(message, windowMs) {
    if (!message.subjectKey) return [];
    return this.#db.prepare("SELECT value FROM email_intake_conversations WHERE recipient=? AND sender=? AND subject_key=? AND last_received_at BETWEEN ? AND ? ORDER BY id").all(
      message.recipient, message.sender, message.subjectKey,
      new Date(Date.parse(message.receivedAt) - windowMs).toISOString(), message.receivedAt,
    ).map((row) => JSON.parse(row.value));
  }

  receipt(key) {
    const row = this.#db.prepare("SELECT * FROM email_intake_receipts WHERE key=?").get(key);
    return row ? {intakeId: row.intake_id, receipt: JSON.parse(row.value)} : null;
  }

  addReceipt(key, intakeId, receipt) {
    this.#requireTransaction();
    this.#db.prepare("INSERT INTO email_intake_receipts VALUES (?, ?, ?)").run(key, intakeId, JSON.stringify(receipt));
  }

  enqueue(effect) {
    this.#requireTransaction();
    const payload = JSON.stringify(effect.payload);
    const prior = this.#db.prepare("SELECT * FROM email_intake_effects WHERE key=?").get(effect.key);
    if (prior) {
      if (prior.intake_id !== effect.intakeId || prior.kind !== effect.kind || prior.payload !== payload) throw new Error("effect key conflict");
      return;
    }
    this.#db.prepare("INSERT INTO email_intake_effects VALUES (?, ?, ?, ?, NULL)").run(effect.key, effect.intakeId, effect.kind, payload);
  }

  pendingEffects() {
    return this.#db.prepare("SELECT * FROM email_intake_effects WHERE result IS NULL ORDER BY rowid").all().map((row) => ({key: row.key, intakeId: row.intake_id, kind: row.kind, payload: JSON.parse(row.payload)}));
  }

  effect(key) {
    const row = this.#db.prepare("SELECT * FROM email_intake_effects WHERE key=?").get(key);
    return row ? {key: row.key, intakeId: row.intake_id, kind: row.kind, payload: JSON.parse(row.payload), result: row.result == null ? null : JSON.parse(row.result)} : null;
  }

  acknowledgeEffect(key, result) {
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("effect result must be an object");
    const encoded = JSON.stringify(result);
    return this.atomic(`effect-ack:${key}`, encoded, () => {
      if (this.#db.prepare("UPDATE email_intake_effects SET result=? WHERE key=? AND result IS NULL").run(encoded, key).changes !== 1) throw new Error("unknown or acknowledged effect");
      return result;
    });
  }
}
