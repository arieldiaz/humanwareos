import {appendFile, mkdir} from "node:fs/promises";
import {createHash, randomUUID} from "node:crypto";
import {dirname, join} from "node:path";
import {renderCoverageContext, resolveExecutionPlan} from "./broker-core.mjs";
import {readFileSync} from "node:fs";

function safeName(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 24);
}

function assistantText(messages = []) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    if (typeof message.content === "string" && message.content.trim()) return message.content.trim();
    if (!Array.isArray(message.content)) continue;
    const text = message.content.filter((part) => part?.type === "text" || part?.type === "output_text").map((part) => part.text ?? "").join("\n").trim();
    if (text) return text;
  }
  return "";
}

export function createEventRecorder({dataRoot}) {
  return async function record(event) {
    const ts = event.ts ?? new Date().toISOString();
    const normalized = {schemaVersion: 2, ts, ...event};
    const dayPath = join(dataRoot, "evidence", "sessions", "events", `${ts.slice(0, 10)}.jsonl`);
    const rawPath = join(dataRoot, "evidence", "sessions", "raw", `${safeName(event.traceId)}.jsonl`);
    const sessionPath = join(dataRoot, "generated", "sessions", `${safeName(event.logicalSessionId)}.md`);
    await mkdir(dirname(dayPath), {recursive: true});
    await mkdir(dirname(rawPath), {recursive: true});
    await mkdir(dirname(sessionPath), {recursive: true});
    await appendFile(dayPath, `${JSON.stringify(normalized)}\n`, {mode: 0o600});
    await appendFile(rawPath, `${JSON.stringify({ts, kind: event.kind, sourceRef: event.sourceRef, details: event.details})}\n`, {mode: 0o600});
    await appendFile(sessionPath, `- ${ts} · ${event.kind} · ${event.summary}\n`, {mode: 0o600});
  };
}

export default {
  id: "execution-broker",
  name: "Humanware Execution Broker",
  description: "Resolves typed execution profiles before inference and records one canonical delivery ledger.",
  register(api) {
    const catalogPath = String(api.pluginConfig?.catalogPath ?? "");
    if (!catalogPath) throw new Error("execution-broker requires plugin config catalogPath");
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    const dataRoot = String(api.pluginConfig?.dataRoot ?? process.env.HUMANWARE_DATA_ROOT ?? "");
    if (!dataRoot) throw new Error("execution-broker requires plugin config dataRoot or HUMANWARE_DATA_ROOT");
    const record = createEventRecorder({dataRoot});
    const plansByRun = new Map();
    const plansBySession = new Map();

    function sessionPlans(sessionKey) {
      if (!sessionKey) return [];
      return plansBySession.get(sessionKey) ?? [];
    }

    function latestPlan(sessionKey, predicate = () => true) {
      const plans = sessionPlans(sessionKey);
      for (let index = plans.length - 1; index >= 0; index -= 1) {
        if (predicate(plans[index])) return plans[index];
      }
    }

    function retainPlan(plan) {
      const plans = sessionPlans(plan.sessionKey);
      plans.push(plan);
      plansBySession.set(plan.sessionKey, plans.slice(-8));
    }

    async function persistPlan(plan, ctx) {
      const prior = api.runtime.agent.session.getSessionEntry({agentId: plan.agentId, sessionKey: ctx.sessionKey, readConsistency: "latest"});
      if (!prior) return undefined;
      const priorState = prior.pluginExtensions?.[api.id];
      const nextState = {
        schemaVersion: 1,
        profileId: plan.profileId,
        traceId: plan.traceId,
        resolvedAt: new Date().toISOString(),
        source: plan.source,
      };
      const patched = await api.runtime.agent.session.patchSessionEntry({
        agentId: plan.agentId,
        sessionKey: ctx.sessionKey,
        readConsistency: "latest",
        preserveActivity: true,
        update: (entry) => ({
          thinkingLevel: plan.profile.reasoning ?? entry.thinkingLevel,
          fastMode: plan.profile.fastMode ?? entry.fastMode,
          pluginExtensions: {...(entry.pluginExtensions ?? {}), [api.id]: nextState},
        }),
      });
      if (!patched) return undefined;
      plan.persisted = true;
      return priorState;
    }

    api.on("inbound_claim", async (event, ctx) => {
      const agentId = String(ctx.agentId ?? event.accountId ?? ctx.accountId ?? "").toLowerCase();
      if (!catalog.agents?.[agentId] || !ctx.sessionKey) return;
      const entry = api.runtime.agent.session.getSessionEntry({agentId, sessionKey: ctx.sessionKey, readConsistency: "latest"});
      const persistedProfile = entry?.pluginExtensions?.[api.id]?.profileId;
      let plan;
      try {
        plan = resolveExecutionPlan({
          input: event.bodyForAgent ?? event.content ?? event.body,
          catalog,
          agentId,
          channelId: ctx.channelId ?? event.channel,
          conversationId: ctx.conversationId ?? event.conversationId,
          persistedProfile,
        });
        plan.traceId = `hw-${randomUUID()}`;
        plan.sessionKey = ctx.sessionKey;
        plan.logicalSessionId = ctx.sessionKey;
        const priorState = await persistPlan(plan, ctx);
        plansByRun.set(ctx.runId ?? plan.traceId, plan);
        retainPlan(plan);
        await record({
          id: `${plan.traceId}:accepted`, traceId: plan.traceId, logicalSessionId: ctx.sessionKey,
          agent: agentId, source: ctx.channelId ?? event.channel, kind: "turn.accepted", level: "normal",
          summary: `Accepted ${plan.intents.length} request item(s)`, details: {intents: plan.intents},
          sourceRef: {sessionKey: ctx.sessionKey, messageId: event.messageId},
        });
        if (priorState?.profileId && priorState.profileId !== plan.profileId) {
          await record({
            id: `${plan.traceId}:handoff`, traceId: plan.traceId, logicalSessionId: ctx.sessionKey,
            agent: agentId, source: "execution-broker", kind: "handoff.created", level: "normal",
            summary: `Handoff ${priorState.profileId} -> ${plan.profileId}`,
            details: {fromProfile: priorState.profileId, toProfile: plan.profileId}, sourceRef: {sessionKey: ctx.sessionKey},
          });
        }
        await record({
          id: `${plan.traceId}:route`, traceId: plan.traceId, logicalSessionId: ctx.sessionKey,
          agent: agentId, source: "execution-broker", kind: "route.resolved", level: "normal",
          summary: `Resolved ${plan.profileId} from ${plan.source}`,
          details: {profileId: plan.profileId, profile: plan.profile, style: plan.style}, sourceRef: {sessionKey: ctx.sessionKey},
        });
      } catch (error) {
        const traceId = `hw-${randomUUID()}`;
        await record({
          id: `${traceId}:failed`, traceId, logicalSessionId: ctx.sessionKey, agent: agentId,
          source: "execution-broker", kind: "execution.failed", level: "normal",
          summary: "Execution routing failed visibly", details: {error: String(error?.message ?? error)}, sourceRef: {sessionKey: ctx.sessionKey},
        }).catch(() => {});
        return {handled: true, reply: {text: `⚠️ ${agentId || "Agent"} could not start this turn: ${String(error?.message ?? error)} · trace ${traceId}`}};
      }
    });

    api.on("before_model_resolve", (event, ctx) => {
      const plan = plansByRun.get(ctx.runId) ?? latestPlan(ctx.sessionKey);
      if (!plan) return;
      const slash = plan.profile.model.indexOf("/");
      if (slash < 1) throw new Error(`profile ${plan.profileId} has invalid model ref ${plan.profile.model}`);
      return {providerOverride: plan.profile.model.slice(0, slash), modelOverride: plan.profile.model.slice(slash + 1)};
    });

    api.on("agent_turn_prepare", async (event, ctx) => {
      const plan = plansByRun.get(ctx.runId) ?? latestPlan(ctx.sessionKey);
      if (!plan) return;
      if (!plan.persisted) await persistPlan(plan, ctx);
      return {prependContext: renderCoverageContext(plan)};
    });

    api.on("model_call_started", async (event, ctx) => {
      const plan = plansByRun.get(ctx.runId) ?? latestPlan(ctx.sessionKey);
      if (!plan || plan.started) return;
      plan.started = true;
      await record({
        id: `${plan.traceId}:started`, traceId: plan.traceId, logicalSessionId: plan.logicalSessionId,
        agent: plan.agentId, source: "execution-broker", kind: "execution.started", level: "normal",
        summary: `Started ${plan.profile.harness}/${plan.profile.model}`,
        details: {profileId: plan.profileId, provider: event.provider, model: event.model, runId: ctx.runId},
        sourceRef: {sessionKey: ctx.sessionKey, runId: ctx.runId},
      });
    });

    api.on("before_agent_finalize", (event, ctx) => {
      const plan = plansByRun.get(ctx.runId) ?? latestPlan(ctx.sessionKey);
      if (!plan || String(event.lastAssistantMessage ?? "").trim()) return;
      return {
        action: "revise",
        reason: "The selected runtime produced no user-visible final.",
        retry: {
          instruction: `Return one explicit user-visible final now. Address every item in the request coverage ledger, or identify each blocked item. If execution failed, state the failure and include trace ${plan.traceId}.`,
          idempotencyKey: `${plan.traceId}:missing-final`,
          maxAttempts: 1,
        },
      };
    });

    api.on("agent_end", async (event, ctx) => {
      const plan = plansByRun.get(ctx.runId) ?? latestPlan(ctx.sessionKey);
      if (!plan) return;
      const text = assistantText(event.messages);
      plan.ended = true;
      await record({
        id: `${plan.traceId}:completed`, traceId: plan.traceId, logicalSessionId: plan.logicalSessionId,
        agent: plan.agentId, source: "execution-broker", kind: event.success && text ? "execution.completed" : "execution.failed", level: "normal",
        summary: event.success && text ? "Runtime returned a canonical final" : "Runtime failed or ended without a canonical final",
        details: {profileId: plan.profileId, success: event.success, error: event.error, durationMs: event.durationMs, finalChars: text.length}, sourceRef: {sessionKey: ctx.sessionKey, runId: ctx.runId},
      });
    });

    api.on("reply_payload_sending", async (event, ctx) => {
      if (event.kind !== "final") return;
      const sessionKey = event.sessionKey ?? ctx.sessionKey;
      const plan = plansByRun.get(event.runId ?? ctx.runId) ?? latestPlan(sessionKey, (candidate) => !candidate.deliveryQueued);
      if (!plan) return;
      const text = String(event.payload?.text ?? "").trim();
      if (text) {
        plan.deliveryQueued = true;
        await record({
          id: `${plan.traceId}:queued`, traceId: plan.traceId, logicalSessionId: plan.logicalSessionId,
          agent: plan.agentId, source: "execution-broker", kind: "delivery.queued", level: "normal",
          summary: "Canonical final queued for adapter delivery", details: {characters: text.length}, sourceRef: {sessionKey},
        });
        return;
      }
      return {payload: {...event.payload, text: `⚠️ ${plan.agentId} finished without a deliverable response · trace ${plan.traceId}`}};
    });

    api.on("message_sent", async (event, ctx) => {
      const sessionKey = event.sessionKey ?? ctx.sessionKey;
      const plan = latestPlan(sessionKey, (candidate) => candidate.deliveryQueued && !candidate.deliveryConfirmed);
      if (!plan) return;
      if (!event.success) {
        plan.deliveryConfirmed = false;
        await record({
          id: `${plan.traceId}:delivery-failed`, traceId: plan.traceId, logicalSessionId: plan.logicalSessionId,
          agent: plan.agentId, source: ctx.channelId, kind: "delivery.failed", level: "normal",
          summary: "Channel adapter reported a delivery failure", details: {error: event.error, channel: ctx.channelId},
          sourceRef: {sessionKey},
        });
        return;
      }
      plan.deliveryConfirmed = true;
      await record({
        id: `${plan.traceId}:delivered:${event.messageId}`, traceId: plan.traceId, logicalSessionId: plan.logicalSessionId,
        agent: plan.agentId, source: ctx.channelId, kind: "delivery.confirmed", level: "normal",
        summary: "Channel adapter confirmed delivery", details: {messageId: event.messageId, channel: ctx.channelId},
        sourceRef: {sessionKey, messageId: event.messageId},
      });
      if (ctx.runId) plansByRun.delete(ctx.runId);
    });
  },
};
