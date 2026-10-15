import {slackRoute, slackRouteKey} from './slack-route.mjs';

// Run lifecycle is internal evidence. Slack root status is separate,
// human-authored workflow data and is never written from this class.
export class ThreadLifecycle {
  constructor({record, report, excluded = () => false}) {
    Object.assign(this, {record, report, excluded});
    this.runs = new Map(); // run key → running turn
    this.latest = new Map(); // conversation → latest admitted run or close
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
    const turn = this.runs.get(`${slackRouteKey(route)}:${runId}`);
    if (!turn) return;
    this.runs.delete(turn.key);
    await this.settle(turn, 'act');
  }
  async close({route, sessionKey, accountId}) {
    if (!route || this.excluded(route.channel)) throw new Error('close_thread needs a Slack thread outside excluded channels');
    const conversation = slackRouteKey(route);
    const turn = {key: `${conversation}:close`, route, conversation, sessionKey, accountId};
    this.latest.set(conversation, turn.key);
    await this.record({...turn, status: 'closed'});
    await this.report(turn);
  }
  async settle(turn, status) {
    if (this.latest.get(turn.conversation) !== turn.key) return;
    await this.record({...turn, status});
  }
}
