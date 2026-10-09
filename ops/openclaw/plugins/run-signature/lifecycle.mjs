import {slackRoute, slackRouteKey} from './slack-route.mjs';

// Stateless thread lifecycle. A run's first model input projects 🔄 and its end
// projects ✋. An owner close projects ✅ at once; the close report follows the
// run's final reply. Nothing is stored: the in-process maps only pair a run's
// start with its end and remember a close until that run ends.
export class ThreadLifecycle {
  constructor({project, record, report, excluded = () => false}) {
    Object.assign(this, {project, record, report, excluded});
    this.runs = new Map(); // run key → running turn
    this.latest = new Map(); // conversation → latest admitted run or close
    this.closes = new Map(); // conversation → turn whose end posts the close report
  }
  route(sessionKey) {
    const route = slackRoute({sessionKey});
    return route && !this.excluded(route.channel) ? route : undefined;
  }
  async start({sessionKey, runId}) {
    const route = this.route(sessionKey);
    if (!route || !runId) return;
    const conversation = slackRouteKey(route), key = `${conversation}:${runId}`;
    if (this.runs.has(key)) return;
    const turn = {key, route, conversation, runId, sessionKey, accountId: sessionKey.split(':')[1]};
    this.runs.set(key, turn);
    this.latest.set(conversation, key);
    await this.settle(turn, 'working');
  }
  async end({sessionKey, runId}) {
    const route = this.route(sessionKey);
    if (!route || !runId) return;
    const conversation = slackRouteKey(route);
    const turn = this.runs.get(`${conversation}:${runId}`);
    if (!turn) return;
    this.runs.delete(turn.key);
    const close = this.closes.get(conversation);
    if (!close) return this.settle(turn, 'act');
    this.closes.delete(conversation);
    await this.report(close);
  }
  // ✅ goes on the root now. The report waits for the live run to end so it
  // lands after the final reply; without a live run it posts immediately.
  async close({route, sessionKey, accountId}) {
    if (!route || this.excluded(route.channel)) throw new Error('close_thread needs a Slack thread outside excluded channels');
    const conversation = slackRouteKey(route);
    const run = [...this.runs.values()].findLast(turn => turn.conversation === conversation);
    const turn = run ?? {key: `${conversation}:close`, route, conversation, sessionKey, accountId};
    this.latest.set(conversation, turn.key);
    await this.record({...turn, status: 'closed'});
    await this.project('closed', turn);
    if (run) this.closes.set(conversation, turn);
    else await this.report(turn);
  }
  async settle(turn, status) {
    if (this.latest.get(turn.conversation) !== turn.key) return;
    await this.record({...turn, status});
    await this.project(status, turn);
  }
}
