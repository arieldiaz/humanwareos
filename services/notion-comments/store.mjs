import {DatabaseSync} from 'node:sqlite';
import {chmodSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

// One row per (Notion comment id, agent connection). The primary key is the
// idempotency boundary: replays never create a second turn or reply.
// States: received -> ignored | dispatching -> waiting -> replying -> replied | no_reply,
// and held(reason) when an outcome is ambiguous or failed.
const DISPATCHED = `state NOT IN ('received', 'ignored')`;

export class Store {
  constructor(path) {
    mkdirSync(dirname(path), {recursive: true, mode: 0o700});
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS notion_comments (
        comment_id TEXT NOT NULL, agent_id TEXT NOT NULL, event_id TEXT, page_id TEXT,
        received_at TEXT NOT NULL, updated_at TEXT NOT NULL, state TEXT NOT NULL, reason TEXT,
        discussion_id TEXT, session_key TEXT, run_id TEXT, dispatched_at INTEGER,
        reply_text TEXT, reply_comment_id TEXT, PRIMARY KEY (comment_id, agent_id));`);
  }
  receive(commentId, agentId, eventId, pageId) {
    const now = new Date().toISOString();
    return this.db.prepare(`INSERT OR IGNORE INTO notion_comments (comment_id, agent_id, event_id, page_id, received_at, updated_at, state)
      VALUES (?, ?, ?, ?, ?, ?, 'received')`).run(commentId, agentId, eventId ?? null, pageId ?? null, now, now).changes === 1;
  }
  get(commentId, agentId) { return this.db.prepare('SELECT * FROM notion_comments WHERE comment_id=? AND agent_id=?').get(commentId, agentId); }
  update(commentId, agentId, fields) {
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE notion_comments SET ${keys.map(k => `${k}=?`).join(', ')}, updated_at=? WHERE comment_id=? AND agent_id=?`)
      .run(...keys.map(k => fields[k] ?? null), new Date().toISOString(), commentId, agentId);
  }
  inState(state) { return this.db.prepare('SELECT * FROM notion_comments WHERE state=? ORDER BY rowid').all(state); }
  // Admission without a confirmed run id, or a reply POST without a confirmed
  // result, has an unknown outcome. A persisted run id resumes waiting instead.
  holdInterrupted() {
    this.db.prepare(`UPDATE notion_comments SET state='held', reason='interrupted_' || state, updated_at=? WHERE state IN ('dispatching', 'replying')`)
      .run(new Date().toISOString());
  }
  // The discussion's current lead is the agent that most recently took an owner turn there.
  lead(discussionId) {
    return this.db.prepare(`SELECT agent_id FROM notion_comments WHERE discussion_id=? AND ${DISPATCHED} ORDER BY rowid DESC LIMIT 1`)
      .get(discussionId)?.agent_id ?? null;
  }
  health() {
    const count = state => this.db.prepare('SELECT count(*) AS n FROM notion_comments WHERE state=?').get(state).n;
    return {sqlite: this.db.prepare('PRAGMA quick_check').get().quick_check === 'ok', pending: count('received'), waiting: count('waiting'), held: count('held')};
  }
  close() { this.db.close(); }
}
