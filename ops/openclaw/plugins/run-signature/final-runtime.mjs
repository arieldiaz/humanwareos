import {mkdir, readFile, writeFile, rename} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {FINAL_SCHEMA, FINAL_INSTRUCTION, decodeFinal, validateEvidence, sameConversationWake, finalText} from './final-envelope.mjs';
import {conversationFenceRoute, conversationFenceKey} from './conversation-fence.mjs';

export const FINAL_RUNTIME = Symbol.for('humanware.final-envelope.v1');

// Durable per-turn decision journal; the append-only session ledger is its
// public projection. A reservation survives retries without recomputing status.
export class FinalRuntime {
  constructor({root, project, record, fault, wakes, fences, humanInputs, close, send, excluded = () => false}) {
    Object.assign(this, {root, project, record, fault, wakes, fences, humanInputs, close, send, excluded});
    this.pending = Promise.resolve();
    this.active = new Map();
  }
  schema(params) { return this.route(params) ? FINAL_SCHEMA : undefined; }
  route(params) {
    const route = conversationFenceRoute({sessionKey: params.sessionKey});
    return route && !this.excluded(route.channel) && !params.isolatedCompletion && !params.controlOperation ? route : undefined;
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
  async human(route, input) {
    const conversation = conversationFenceKey(route);
    const changed = await this.state(state => {
      const prior = state.conversations[conversation];
      if (prior?.lastHumanMessage === input.messageId) return false;
      state.conversations[conversation] = {...prior, lastHumanMessage: input.messageId, owner: `inbound:${input.messageId}`};
      return true;
    });
    if (!changed) return;
    this.humanInputs.set(conversation, input);
    await this.fences.reopenFromHuman(route, {messageId: input.messageId});
  }
  async run(params, execute, kind) {
    const route = this.route(params);
    if (!route) return execute(params);
    if (!params.runId) throw new Error('Final contract requires an admitted run id');
    const key = `${conversationFenceKey(route)}:${params.runId}`;
    const accountId = params.accountId ?? params.agentId ?? params.sessionKey.split(':')[1];
    const conversation = conversationFenceKey(route);
    const admission = await this.state(state => {
      const prior = state.turns[key];
      if (prior) return prior;
      const turn = {key, route, conversation, runId: params.runId, sessionKey: params.sessionKey, accountId,
        previous: state.conversations[conversation]?.status, phase: 'running', startedAt: Date.now(),
        humanInput: this.humanInputs.get(conversation)};
      state.turns[key] = turn;
      state.conversations[conversation] = {...state.conversations[conversation], owner: key};
      return turn;
    });
    this.humanInputs.delete(conversation);
    if (admission.phase !== 'running') throw new Error('Turn already settled; replay its durable delivery, not model execution');
    if (this.fences.shouldSuppress(route, {workCreatedAt: admission.startedAt})) throw new Error('Conversation is closed');
    this.active.set(params.runId, admission);
    let current = {...params, prompt: `${params.prompt ?? ''}\n\n${FINAL_INSTRUCTION}`};
    try {
      await this.record({...admission, status: 'working'});
      await this.project('working', admission);
      let result, envelope;
      for (let attempt = 0; attempt < 2; attempt++) {
        admission.repair = attempt === 1;
        result = await execute(current);
        if (result.meta?.aborted) throw new Error('CLI execution interrupted before a valid final');
        if (result.terminal && result.terminal.kind !== 'ok') throw new Error(`Harness terminated: ${result.terminal.kind}`);
        try {
          envelope = decodeFinal(finalText(result, kind));
          const jobs = envelope.status === 'scheduled' ? await this.wakes(params.sessionKey) : [];
          validateEvidence(envelope, {humanInput: admission.humanInput,
            wakes: jobs.filter(job => sameConversationWake(job, params.sessionKey)).map(job => ({enabled: job.enabled, nextRunAtMs: job.state.nextRunAtMs}))});
          break;
        } catch (error) {
          if (attempt) throw error;
          current = {...params, toolsAllow: [],
            cliSessionId: result.meta?.agentMeta?.sessionId ?? params.cliSessionId,
            prompt: `${FINAL_INSTRUCTION}\nRepair only the final envelope. Do not repeat any tools or completed work. Validation error: ${error.message}\nPrevious final:\n${finalText(result, kind)}`};
        }
      }
      await this.state(state => {
        if (state.conversations[conversation]?.owner !== key) throw new Error('Superseded turn cannot commit');
        state.turns[key] = {...state.turns[key], envelope, phase: 'reserved'};
      });
      await this.deliver(key);
      return result;
    } catch (error) {
      await this.fail(key, error);
      throw error;
    } finally { this.active.delete(params.runId); }
  }
  async fail(key, error) {
    await this.state(async state => {
      const turn = state.turns[key];
      if (!turn || ['sent', 'delivered', 'failed'].includes(turn.phase)) return;
      turn.phase = 'failed';
      turn.failure = String(error.message ?? error);
      await this.fault(turn, turn.failure);
      if (state.conversations[turn.conversation]?.owner === key) {
        await this.record({...turn, status: turn.previous ?? null, recovery: true});
        await this.project(turn.previous, turn);
      }
    });
  }
  async prepare(event, ctx) {
    if (!this.route({sessionKey: event.sessionKey ?? ctx.sessionKey})) return;
    return {cancel: true, reason: 'The final contract owns the one durable source delivery'};
  }
  async deliver(key) {
    const turn = await this.state(state => {
      const turn = state.turns[key];
      if (!turn || !['reserved', 'queued'].includes(turn.phase)) return;
      if (state.conversations[turn.conversation]?.owner !== key) {
        turn.phase = 'superseded';
        return;
      }
      turn.phase = 'queued';
      return turn;
    });
    if (!turn) return;
    // Replays use the same durable transport idempotency key, never a new send
    // inferred from matching text or a second semantic decision.
    const receipt = await this.send(turn);
    const messageId = receipt?.messageId ?? receipt?.result?.messageId;
    if (!messageId) throw new Error('Durable transport returned no confirmed message receipt');
    await this.state(state => {
      state.turns[key].phase = 'delivered';
      state.turns[key].messageId = String(messageId);
    });
    await this.finish(key);
  }
  async finish(key) {
    await this.state(async state => {
      const turn = state.turns[key];
      if (turn?.phase !== 'delivered') return;
      if (state.conversations[turn.conversation]?.owner === key) {
        await this.record({...turn, status: turn.envelope.status});
        if (turn.envelope.status === 'closed') await this.close(turn, turn.messageId);
        await this.project(turn.envelope.status, turn);
        state.conversations[turn.conversation].status = turn.envelope.status;
      }
      turn.phase = 'sent';
    });
  }
  async recover() {
    const turns = await this.state(state => Object.values(state.turns));
    for (const turn of turns) {
      if (turn.phase === 'delivered') await this.finish(turn.key);
      else if (['reserved', 'queued'].includes(turn.phase)) await this.deliver(turn.key);
      else if (turn.phase === 'running') await this.fail(turn.key, new Error('Execution interrupted before final reservation'));
    }
  }
}
