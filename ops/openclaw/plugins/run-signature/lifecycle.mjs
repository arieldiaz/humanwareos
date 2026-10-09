import {randomUUID} from 'node:crypto';
import {conversationFenceRoute, conversationFenceKey} from './conversation-fence.mjs';

// Stateless thread lifecycle. Status derives from the current run (working →
// act) plus host close; the root's bot-held ✅ in Slack is the only record of
// closure and the append-only session ledger is the public record. In-process
// maps only dedupe repeated hook events and in-flight closes.
export class ThreadLifecycle {
  constructor({project, record, closed, snapshot, writeReport, completeClose, send, excluded = () => false}) {
    Object.assign(this, {project, record, closed, snapshot, writeReport, completeClose, send, excluded});
    this.runs = new Map(); // run key → running turn
    this.latest = new Map(); // conversation → latest admitted run or close key
    this.pendingClose = new Map(); // run key → owner close request
    this.closing = new Map(); // conversation → in-flight close
  }
  route(sessionKey) {
    const route = conversationFenceRoute({sessionKey});
    return route && !this.excluded(route.channel) ? route : undefined;
  }
  async isClosingOrClosed(route, accountId) {
    return this.closing.has(conversationFenceKey(route)) || Boolean(await this.closed(route, accountId));
  }
  // A close requested during a run takes effect when that run ends. If a
  // restart lost the start hook, the matching conversation's end hook still
  // applies the request after the final response has settled.
  async requestClose(route, input, assertCurrent = () => {}) {
    const conversation = conversationFenceKey(route);
    if (!conversation) throw new Error('Closure needs a Slack thread');
    const run = [...this.runs.values()].findLast(turn => turn.conversation === conversation);
    assertCurrent();
    this.pendingClose.set(run?.key ?? conversation, {...input, reservationId: randomUUID()});
  }
  async closeCommand(route, {reservationId, principal, accountId}) {
    if (!reservationId || !principal || !accountId) throw new Error('Closure requires reservation, principal and configured sender');
    const conversation = conversationFenceKey(route);
    if (!conversation) throw new Error('Canonical closure route is unavailable');
    if (this.closing.has(conversation)) return this.closing.get(conversation);
    const startedAt = Date.now(), key = `${conversation}:close:${reservationId}`;
    const work = (async () => {
      // A repeated close on a thread whose root still shows ✅ is a no-op.
      if (await this.closed(route, accountId)) return;
      const close = {key, conversation, route, principal, accountId, startedAt,
        evidence: [...this.runs.values()].filter(turn => turn.conversation === conversation).map(({runId}) => ({runId, phase: 'running'})),
        sessionKey: `agent:${accountId}:slack:channel:${route.channel.toLowerCase()}:thread:${route.threadId}`};
      this.latest.set(conversation, key);
      close.snapshot = await this.snapshot(close);
      await this.writeReport(close);
      await this.send({...close, text: close.snapshot.report, closeOperation: key});
      await this.completeClose(close);
      if (this.latest.get(conversation) === key) await this.project('closed', close);
    })().finally(() => this.closing.delete(conversation));
    this.closing.set(conversation, work);
    return work;
  }
  // The first model input of a run admits it; repeated calls are no-ops.
  async start({sessionKey, runId}) {
    const route = this.route(sessionKey);
    if (!route || !runId) return;
    const conversation = conversationFenceKey(route), key = `${conversation}:${runId}`;
    if (this.runs.has(key)) return;
    const turn = {key, route, conversation, runId, sessionKey, accountId: sessionKey.split(':')[1]};
    this.runs.set(key, turn);
    this.latest.set(conversation, key);
    await this.settle(turn, 'working');
  }
  // A finished run returns the turn to the human, whatever its reply was.
  async end({sessionKey, runId}) {
    const route = this.route(sessionKey);
    if (!route || !runId) return;
    const conversation = conversationFenceKey(route);
    const turn = this.runs.get(`${conversation}:${runId}`);
    const close = this.pendingClose.get(turn?.key) ?? this.pendingClose.get(conversation);
    if (turn) {
      this.runs.delete(turn.key);
      await this.settle(turn, 'act');
      this.pendingClose.delete(turn.key);
    }
    this.pendingClose.delete(conversation);
    if (close) await this.closeCommand(route, close);
  }
  async settle(turn, status) {
    if (this.latest.get(turn.conversation) !== turn.key) return;
    await this.record({...turn, status});
    await this.project(status, turn);
  }
}
