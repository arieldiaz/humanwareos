import {DatabaseSync} from 'node:sqlite';
import {chmodSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

// One row per Notion comment id. The primary key is the idempotency boundary:
// replays of the same comment never create a second turn or reply.
// States: received -> ignored | dispatching -> replying -> replied | no_reply,
// and held(code) whenever an outcome is unknown or rejected.
export class Store {
  constructor(path) {
    mkdirSync(dirname(path), {recursive: true, mode: 0o700});
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS notion_comments (
        comment_id TEXT PRIMARY KEY, event_id TEXT, page_id TEXT, received_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        state TEXT NOT NULL, reason TEXT, discussion_id TEXT, agent_id TEXT, session_key TEXT,
        reply_text TEXT, reply_comment_id TEXT);`);
  }
  receive(commentId, eventId, pageId) {
    const now = new Date().toISOString();
    return this.db.prepare(`INSERT OR IGNORE INTO notion_comments (comment_id, event_id, page_id, received_at, updated_at, state)
      VALUES (?, ?, ?, ?, ?, 'received')`).run(commentId, eventId ?? null, pageId ?? null, now, now).changes === 1;
  }
  get(commentId) { return this.db.prepare('SELECT * FROM notion_comments WHERE comment_id=?').get(commentId); }
  update(commentId, fields) {
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE notion_comments SET ${keys.map(k => `${k}=?`).join(', ')}, updated_at=? WHERE comment_id=?`)
      .run(...keys.map(k => fields[k] ?? null), new Date().toISOString(), commentId);
  }
  pending() { return this.db.prepare(`SELECT comment_id FROM notion_comments WHERE state='received' ORDER BY rowid`).all().map(r => r.comment_id); }
  // A turn or reply that was started but never confirmed has an unknown outcome.
  holdInterrupted() {
    this.db.prepare(`UPDATE notion_comments SET state='held', reason='interrupted_' || state, updated_at=? WHERE state IN ('dispatching', 'replying')`)
      .run(new Date().toISOString());
  }
  lead(discussionId) {
    return this.db.prepare(`SELECT agent_id FROM notion_comments WHERE discussion_id=? AND agent_id IS NOT NULL ORDER BY rowid DESC LIMIT 1`)
      .get(discussionId)?.agent_id ?? null;
  }
  health() {
    return {sqlite: this.db.prepare('PRAGMA quick_check').get().quick_check === 'ok',
      pending: this.pending().length,
      held: this.db.prepare(`SELECT count(*) AS n FROM notion_comments WHERE state='held'`).get().n};
  }
  close() { this.db.close(); }
}
