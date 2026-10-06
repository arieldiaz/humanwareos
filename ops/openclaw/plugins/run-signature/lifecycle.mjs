import {mkdir, readFile, writeFile, rename} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {conversationFenceRoute, conversationFenceKey} from './conversation-fence.mjs';

// Durable per-thread lifecycle journal; the append-only session ledger is its
// public projection. Status derives from the run lifecycle (working → act) plus
// host close. Status is soft: the latest admitted run owns the root tile, and a
// host close is one more status whose next admitted run simply replaces it.
export class ThreadLifecycle {
  constructor({root, project, record, fault, snapshot, writeReport, completeClose, excluded = () => false}) {
    Object.assign(this, {root, project, record, fault, snapshot, writeReport, completeClose, excluded});
    this.pending = Promise.resolve();
    this.closing = new Map();
  }
  route(sessionKey) {
    const route = conversationFenceRoute({sessionKey});
    return route && !this.excluded(route.channel) ? route : undefined;
  }
  async state(operation) {
    const run = this.pending.catch(() => {}).then(async () => {
      const path = join(this.root, 'final-decisions.json');
      let state;
      try { state = JSON.parse(await readFile(path, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; state = {turns: {}, conversations: {}}; }
      const result = await operation(state);
      await mkdir(dirname(path), {recursive: true});
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(state), {mode: 0o600});
      await rename(tmp, path);
      return result;
    });
    this.pending = run;
    return run;
  }
  conversation(state, route) {
    const key = conversationFenceKey(route);
    if (!key) throw new Error('Canonical closure route is unavailable');
    return state.conversations[key] ??= {};
  }
  async reserveClose(route, {messageId, principal, accountId}) {
    if (!messageId || !principal || !accountId) throw new Error('Closure requires source, principal and configured sender');
    return this.state(state => {
      state.closes ??= {};
      const conversation = this.conversation(state, route);
      const conversationKey = conversationFenceKey(route);
      const prior = Object.values(state.closes).find(close => close.conversation === conversationKey && close.sourceMessageId === messageId);
      if (prior) return prior.key;
      // An unfinished close resumes; a repeated command on an already closed
      // conversation is a no-op until a later admitted run changes the status.
      const current = state.closes[conversation.closeOperation];
      if (current && current.phase !== 'complete') return current.key;
      if (current && conversation.status === 'closed') return;
      const key = `${conversationKey}:close:${messageId}`;
      const startedAt = Date.now();
      state.closes[key] = {key, conversation: conversationKey, route,
        sourceMessageId: messageId, principal, accountId, startedAt, phase: 'reserved',
        evidence: Object.values(state.turns).filter(turn => turn.conversation === conversationKey).map(turn => ({runId: turn.runId, phase: turn.phase})),
        sessionKey: `agent:${accountId}:slack:channel:${route.channel.toLowerCase()}:thread:${route.threadId}`};
      Object.assign(conversation, {owner: key, closeOperation: key});
      return key;
    });
  }
  // The owner's request is recorded during the run and takes effect when it ends.
  async requestClose(sessionKey, input, assertCurrent = () => {}) {
    const route = this.route(sessionKey);
    if (!route) throw new Error('Closure needs a Slack thread');
    await this.state(state => {assertCurrent(); this.conversation(state, route).pendingClose = input;});
  }
  async closeCommand(route, input) {
    const key = await this.reserveClose(route, input);
    if (key) await this.resumeClose(key);
  }
  async resumeClose(key) {
    if (this.closing.has(key)) return this.closing.get(key);
    const work = this.advanceClose(key).finally(() => this.closing.delete(key));
    this.closing.set(key, work);
    return work;
  }
  async advanceClose(key) {
    let close = await this.state(state => state.closes?.[key]);
    if (!close || close.phase === 'complete') return;
    if (close.phase === 'reserved') {
      const snapshot = await this.snapshot(close);
      await this.state(state => Object.assign(state.closes[key], {snapshot, phase: 'snapshot'}));
    }
    close = await this.state(state => state.closes[key]);
    if (close.phase === 'snapshot') {
      await this.writeReport(close);
      await this.state(state => {state.closes[key].phase = 'file';});
    }
    close = await this.state(state => state.closes[key]);
    // Older journals may have stopped in one of the retired Slack-delivery
    // phases. Complete their durable record without replaying the message.
    if (['file', 'sending', 'delivered'].includes(close.phase)) {
      await this.completeClose(close);
      await this.state(state => {state.closes[key].phase = 'recorded';});
    }
    await this.state(async state => {
      close = state.closes[key];
      if (close.phase !== 'recorded') return;
      const conversation = this.conversation(state, close.route);
      if (conversation.owner === key) {
        await this.project('closed', close);
        Object.assign(conversation, {status: 'closed', closedAt: Date.now()});
      }
      close.phase = 'complete';
    });
  }
  // The first model input of a run admits it; repeated calls are no-ops.
  async start({sessionKey, runId}) {
    const route = this.route(sessionKey);
    if (!route || !runId) return;
    const conversation = conversationFenceKey(route), key = `${conversation}:${runId}`;
    await this.state(async state => {
      if (state.turns[key]) return;
      const boundary = this.conversation(state, route);
      const turn = {key, route, conversation, runId, sessionKey, accountId: sessionKey.split(':')[1],
        previous: boundary.status, phase: 'running', startedAt: Date.now()};
      state.turns[key] = turn;
      boundary.owner = key;
      await this.settle(state, turn, 'working');
    });
  }
  // A finished run returns the turn to the human, whatever its reply was.
  async end({sessionKey, runId}) {
    const route = this.route(sessionKey);
    if (!route || !runId) return;
    const close = await this.state(async state => {
      const turn = state.turns[`${conversationFenceKey(route)}:${runId}`];
      if (turn?.phase !== 'running') return;
      turn.phase = 'done';
      await this.settle(state, turn, 'act');
      const conversation = state.conversations[turn.conversation];
      const pending = conversation.pendingClose;
      delete conversation.pendingClose;
      return pending;
    });
    if (close) await this.closeCommand(route, close);
  }
  async settle(state, turn, status, recovery) {
    const conversation = state.conversations[turn.conversation];
    if (conversation?.owner !== turn.key) return;
    await this.record({...turn, status, recovery});
    await this.project(status, turn);
    if (status !== 'working') conversation.status = status;
  }
  async recover() {
    const closes = await this.state(state => Object.values(state.closes ?? {}));
    for (const close of closes) {
      try { await this.resumeClose(close.key); }
      catch (error) { await this.fault(close, String(error.message ?? error)); }
    }
    // A run still marked running did not survive the restart: restore the
    // prior committed status instead of leaving a false working tile.
    await this.state(async state => {
      for (const turn of Object.values(state.turns).filter(turn => turn.phase === 'running')) {
        turn.phase = 'failed';
        // A close requested by an interrupted run is dropped, never applied to a later run.
        delete state.conversations[turn.conversation]?.pendingClose;
        try {
          await this.fault(turn, 'Execution interrupted by restart');
          await this.settle(state, turn, turn.previous ?? null, true);
        } catch (error) { await this.fault(turn, String(error.message ?? error)); }
      }
    });
  }
}
