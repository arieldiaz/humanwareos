import {mkdir, readFile, writeFile, rename} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {FINAL_SCHEMA, FINAL_INSTRUCTION, decodeFinal, validateEvidence, sameConversationWake, finalText, finalMedia} from './final-envelope.mjs';
import {assertLifecycleJournal, conversationFenceRoute, conversationFenceKey} from './conversation-fence.mjs';

export const FINAL_RUNTIME = Symbol.for('humanware.final-envelope.v1');

// Durable per-turn decision journal; the append-only session ledger is its
// public projection. A reservation survives retries without recomputing status.
export class FinalRuntime {
  constructor({root, project, record, fault, wakes, fences, snapshot, writeReport, completeClose, send, excluded = () => false}) {
    Object.assign(this, {root, project, record, fault, wakes, fences, snapshot, writeReport, completeClose, send, excluded});
    this.pending = Promise.resolve();
    this.active = new Map();
    this.closing = new Map();
  }
  schema(params) { return this.route(params) ? FINAL_SCHEMA : undefined; }
  route(params) {
    const route = conversationFenceRoute({sessionKey: params.sessionKey});
    return route && !this.excluded(route.channel) && !params.isolatedCompletion && !params.controlOperation ? route : undefined;
  }
  async state(operation) {
    const run = this.pending.catch(() => {}).then(async () => {
      const path = join(this.root, 'final-decisions.json');
      const state = JSON.parse(await readFile(path, 'utf8'));
      assertLifecycleJournal(state);
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
    if (!state.conversations[key] && Object.values(state.turns).some(turn => turn.conversation === key)) throw new Error('Orphan turn requires historical reconciliation');
    const prior = state.conversations[key];
    if (prior !== undefined) {
      if (!Number.isSafeInteger(prior?.generation) || prior.generation < 0 || !['open', 'closing', 'closed'].includes(prior.state))
        throw new Error('Invalid lifecycle generation; migration/reconciliation required');
      return prior;
    }
    return state.conversations[key] = {generation: 0, state: 'open'};
  }
  eligible(turn, conversation) {
    return conversation.state === 'open' && !conversation.reconciliationRequired &&
      (turn.generation ?? 0) === conversation.generation &&
      (!Number.isFinite(conversation.closedThrough) || turn.startedAt > conversation.closedThrough);
  }
  async human(route, input) {
    await this.state(state => {
      const conversation = this.conversation(state, route);
      if (!input.messageId || conversation.lastHumanMessage === input.messageId ||
          Object.values(state.closes ?? {}).some(close => close.conversation === conversationFenceKey(route) && close.sourceMessageId === input.messageId)) return;
      if (conversation.reconciliationRequired) throw new Error('Historical closure requires reconciliation');
      if (conversation.state === 'closing') throw new Error('Closure is still recovering; retry this human input after completion');
      if (Number(input.messageId) <= Number(conversation.lastHumanMessage ?? 0)) return;
      if (conversation.state === 'closed') {
        conversation.generation++;
        conversation.state = 'open';
        conversation.reopenedByMessageId = input.messageId;
        conversation.reopenedAt = Date.now();
      }
      conversation.lastHumanMessage = input.messageId;
      conversation.owner = `inbound:${input.messageId}`;
    });
  }
  async sender(route) {
    return this.state(state => {
      const conversation = state.conversations[conversationFenceKey(route)];
      return conversation?.sender ?? state.turns[conversation?.owner]?.accountId ?? state.closes?.[conversation?.closeOperation]?.accountId;
    });
  }
  async reserveClose(route, {messageId, principal, accountId}) {
    if (!messageId || !principal || !accountId) throw new Error('Closure requires source, principal and configured sender');
    return this.state(state => {
      state.closes ??= {};
      const conversation = this.conversation(state, route);
      const conversationKey = conversationFenceKey(route);
      const prior = Object.values(state.closes).find(close => close.conversation === conversationKey && close.sourceMessageId === messageId);
      if (prior) return prior.key;
      if (conversation.reconciliationRequired) throw new Error('Historical closure requires reconciliation');
      if (conversation.state !== 'open') return conversation.closeOperation;
      if (Number(messageId) < Number(conversation.lastHumanMessage ?? 0)) return;
      const key = `${conversationKey}:close:${conversation.generation}`;
      const startedAt = Date.now();
      state.closes[key] = {key, conversation: conversationKey, route, generation: conversation.generation,
        sourceMessageId: messageId, principal, accountId, startedAt, phase: 'reserved',
        evidence: Object.values(state.turns).filter(turn => turn.conversation === conversationKey && (turn.generation ?? 0) === conversation.generation).map(turn => ({runId: turn.runId, phase: turn.phase, message: turn.envelope?.message, status: turn.envelope?.status})),
        sessionKey: `agent:${accountId}:slack:channel:${route.channel.toLowerCase()}:thread:${route.threadId}`};
      Object.assign(conversation, {state: 'closing', owner: key, closeOperation: key,
        lastHumanMessage: messageId, closedThrough: startedAt});
      return key;
    });
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
    if (['file', 'sending'].includes(close.phase)) {
      if (close.phase === 'sending' && Date.now() - close.sendStartedAt >= 86400000)
        throw new Error('Close receipt retention expired; reconcile the existing intent before retrying');
      await this.state(state => Object.assign(state.closes[key], {phase: 'sending', sendStartedAt: close.sendStartedAt ?? Date.now()}));
      const receipt = await this.send({...close, envelope: {message: close.snapshot.report}, closeOperation: key});
      const messageId = receipt?.messageId ?? receipt?.result?.messageId;
      if (!messageId) throw new Error('Close report has no confirmed durable receipt');
      await this.state(state => Object.assign(state.closes[key], {phase: 'delivered', messageId, receipts: receipt.parts ?? [receipt]}));
    }
    close = await this.state(state => state.closes[key]);
    if (close.phase === 'delivered') {
      await this.completeClose(close);
      await this.state(state => {state.closes[key].phase = 'recorded';});
    }
    await this.state(async state => {
      close = state.closes[key];
      if (close.phase !== 'recorded') return;
      const conversation = state.conversations[close.conversation];
      if (conversation.closeOperation !== key || conversation.generation !== close.generation) throw new Error('Closure generation mismatch');
      await this.project('closed', close);
      Object.assign(conversation, {state: 'closed', status: 'closed', closedAt: Date.now()});
      close.phase = 'complete';
    });
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
      const boundary = this.conversation(state, route);
      if (boundary.state !== 'open' || boundary.reconciliationRequired) throw new Error('Conversation is fenced');
      const turn = {key, route, conversation, generation: boundary.generation, runId: params.runId, sessionKey: params.sessionKey, accountId,
        previous: state.conversations[conversation]?.status, phase: 'running', startedAt: Date.now()};
      state.turns[key] = turn;
      state.conversations[conversation] = {...state.conversations[conversation], owner: key, sender: accountId};
      return turn;
    });
    if (admission.phase !== 'running') throw new Error('Turn already settled; replay its durable delivery, not model execution');
    this.active.set(params.runId, admission);
    let current = {...params, prompt: `${params.prompt ?? ''}\n\n${FINAL_INSTRUCTION}`};
    try {
      await this.state(async state => {
        if (this.eligible(admission, state.conversations[conversation]) && state.conversations[conversation].owner === key) {
          await this.record({...admission, status: 'working'});
          await this.project('working', admission);
        }
      });
      let result, envelope;
      for (let attempt = 0; attempt < 2; attempt++) {
        admission.repair = attempt === 1;
        result = await execute(current);
        if (result.meta?.aborted) throw new Error('CLI execution interrupted before a valid final');
        if (result.terminal && result.terminal.kind !== 'ok') throw new Error(`Harness terminated: ${result.terminal.kind}`);
        try {
          envelope = decodeFinal(finalText(result, kind));
          const jobs = envelope.status === 'scheduled' ? await this.wakes(params.sessionKey) : [];
          validateEvidence(envelope, {wakes: jobs.filter(job => sameConversationWake(job, params.sessionKey)).map(job => ({enabled: job.enabled, nextRunAtMs: job.state.nextRunAtMs}))});
          break;
        } catch (error) {
          if (attempt) throw error;
          current = {...params, toolsAllow: [],
            cliSessionId: result.meta?.agentMeta?.sessionId ?? params.cliSessionId,
            prompt: `${FINAL_INSTRUCTION}\nRepair only the final envelope. Do not repeat any tools or completed work. Validation error: ${error.message}\nPrevious final:\n${finalText(result, kind)}`};
        }
      }
      await this.state(state => {
        state.turns[key] = {...state.turns[key], envelope, mediaUrls: finalMedia(result), phase: 'reserved'};
      });
      await this.deliver(key);
      return result;
    } catch (error) {
      await this.fail(key, error);
      throw error;
    } finally { this.active.delete(params.runId); }
  }
  async fail(key, error, {abandon = false} = {}) {
    await this.state(async state => {
      const turn = state.turns[key];
      if (!turn || ['sent', 'failed'].includes(turn.phase)) return;
      // A send error does not prove the durable queue failed to publish. Keep
      // its reservation recoverable under the same transport key.
      if (abandon || !['reserved', 'queued', 'delivered'].includes(turn.phase)) turn.phase = 'failed';
      turn.failure = String(error.message ?? error);
      await this.fault(turn, turn.failure);
      if (turn.phase === 'delivered') return;
      if (state.conversations[turn.conversation]?.owner === key && this.eligible(turn, state.conversations[turn.conversation])) {
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
      turn.phase = 'queued';
      return turn;
    });
    if (!turn) return;
    // Serialize the final pre-send check with close reservation. A close cannot
    // cross an already-started dispatch; once reserved, no older dispatch starts.
    await this.state(async state => {
      const current = state.turns[key];
      if (!['act', 'scheduled'].includes(current.envelope?.status)) throw new Error('Legacy model closure requires reconciliation; no model-selected close can dispatch');
      if (!['reserved', 'queued'].includes(current.phase)) return;
      if (!this.eligible(current, this.conversation(state, current.route))) {
        current.phase = 'intentional_non_delivery';
        return;
      }
      const receipt = await this.send(current);
      const messageId = receipt?.messageId ?? receipt?.result?.messageId;
      if (!messageId) throw new Error('Durable transport returned no confirmed message receipt');
      current.phase = 'delivered';
      current.messageId = String(messageId);
    });
    await this.finish(key);
  }
  async finish(key) {
    await this.state(async state => {
      const turn = state.turns[key];
      if (turn?.phase !== 'delivered') return;
      decodeFinal(JSON.stringify(turn.envelope));
      if (state.conversations[turn.conversation]?.owner === key && this.eligible(turn, state.conversations[turn.conversation])) {
        await this.record({...turn, status: turn.envelope.status});
        await this.project(turn.envelope.status, turn);
        state.conversations[turn.conversation].status = turn.envelope.status;
      }
      turn.phase = 'sent';
    });
  }
  async recover() {
    const closes = await this.state(state => Object.values(state.closes ?? {}));
    for (const close of closes) {
      try { await this.resumeClose(close.key); }
      catch (error) { await this.fault(close, String(error.message ?? error)); }
    }
    const turns = await this.state(state => Object.values(state.turns));
    for (const turn of turns) {
      try {
        if (turn.phase === 'delivered') await this.finish(turn.key);
        else if (turn.phase === 'queued' && Date.now() - turn.startedAt >= 86400000)
          await this.fail(turn.key, new Error('Delivery receipt retention expired; reconcile before retrying'), {abandon: true});
        else if (['reserved', 'queued'].includes(turn.phase)) await this.deliver(turn.key);
        else if (turn.phase === 'running') await this.fail(turn.key, new Error('Execution interrupted before final reservation'));
      } catch (error) {
        // One unavailable transport must not prevent recovery of other turns.
        await this.fail(turn.key, error);
      }
    }
  }
}
