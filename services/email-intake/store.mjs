import {DatabaseSync} from 'node:sqlite';
import {mkdirSync, chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {SQLiteIntakeRepository} from './framework.mjs';

export class Store {
  constructor(path, {tablePrefix} = {}) {
    const prefix = tablePrefix ?? 'email_intake';
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(prefix)) throw new Error('invalid_table_prefix');
    this.tables = {evidence: `${prefix}_evidence`, delivery: `${prefix}_delivery`, faults: `${prefix}_faults`, outbound: `${prefix}_outbound`};
    mkdirSync(dirname(path), {recursive: true, mode: 0o700});
    this.repository = new SQLiteIntakeRepository(path);
    chmodSync(path, 0o600);
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS ${this.tables.evidence} (key TEXT PRIMARY KEY, value TEXT NOT NULL, domain_result TEXT);
      CREATE TABLE IF NOT EXISTS ${this.tables.delivery} (key TEXT PRIMARY KEY, started_at TEXT NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS ${this.tables.faults} (key TEXT PRIMARY KEY, code TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ${this.tables.outbound} (id TEXT PRIMARY KEY, status TEXT NOT NULL, draft TEXT NOT NULL, approval TEXT, result TEXT, updated_at TEXT NOT NULL);`);
  }
  // Outbound mail record: draft, approval, then sending → sent | rejected. Rows are never deleted.
  outbound(id) {
    const row = this.db.prepare(`SELECT * FROM ${this.tables.outbound} WHERE id=?`).get(id);
    return row ? {id: row.id, status: row.status, draft: JSON.parse(row.draft), approval: row.approval ? JSON.parse(row.approval) : null, result: row.result ? JSON.parse(row.result) : null} : null;
  }
  addOutbound(draft, status, approval = null) {
    this.db.prepare(`INSERT INTO ${this.tables.outbound} VALUES (?, ?, ?, ?, NULL, ?)`).run(draft.id, status, JSON.stringify(draft), approval && JSON.stringify(approval), new Date().toISOString());
  }
  // Compare-and-set so two concurrent callers cannot both claim one send.
  transitionOutbound(id, from, to, fields = {}) {
    const columns = Object.keys(fields).filter((key) => ['approval', 'result'].includes(key));
    return this.db.prepare(`UPDATE ${this.tables.outbound} SET status=?, updated_at=?${columns.map((key) => `, ${key}=?`).join('')} WHERE id=? AND status=?`)
      .run(to, new Date().toISOString(), ...columns.map((key) => JSON.stringify(fields[key])), id, from).changes === 1;
  }
  evidence(key, value) {
    if (value) this.db.prepare(`INSERT OR IGNORE INTO ${this.tables.evidence} VALUES (?, ?, NULL)`).run(key, JSON.stringify(value));
    const row = this.db.prepare(`SELECT * FROM ${this.tables.evidence} WHERE key=?`).get(key);
    return row ? {value: JSON.parse(row.value), domain: row.domain_result ? JSON.parse(row.domain_result) : null} : null;
  }
  domain(key, result) { this.db.prepare(`UPDATE ${this.tables.evidence} SET domain_result=? WHERE key=?`).run(JSON.stringify(result), key); }
  delivery(key) {
    const row = this.db.prepare(`SELECT * FROM ${this.tables.delivery} WHERE key=?`).get(key);
    return row ? {...row, result: row.result ? JSON.parse(row.result) : null} : null;
  }
  start(key) { this.db.prepare(`INSERT OR IGNORE INTO ${this.tables.delivery} VALUES (?, ?, NULL)`).run(key, new Date().toISOString()); }
  confirmed(key, result) { this.db.prepare(`UPDATE ${this.tables.delivery} SET result=? WHERE key=?`).run(JSON.stringify(result), key); }
  fault(key, code) { return this.db.prepare(`INSERT OR IGNORE INTO ${this.tables.faults} VALUES (?, ?, ?)`).run(key, code, new Date().toISOString()).changes === 1; }
  clearFault(key) { this.db.prepare(`DELETE FROM ${this.tables.faults} WHERE key=?`).run(key); }
  health() {
    return {sqlite: this.db.prepare('PRAGMA quick_check').get().quick_check === 'ok', pending: this.repository.pendingEffects().length,
      faults: this.db.prepare(`SELECT count(*) AS n FROM ${this.tables.faults}`).get().n};
  }
  close() { this.db.close(); this.repository.close(); }
}
