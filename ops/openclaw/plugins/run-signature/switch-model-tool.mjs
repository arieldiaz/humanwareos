import {loadCoreSdk} from "./openclaw-sdk.mjs";

const REASONING = ["off", "low", "medium", "high"];
const reply = (text, isError) => ({content: [{type: "text", text}], ...(isError ? {isError} : {})});

function configuredAgent(config, agentId) {
  const id = String(agentId ?? "").toLowerCase();
  if (config?.agents?.entries && typeof config.agents.entries === "object") return Object.entries(config.agents.entries).find(([key]) => key.toLowerCase() === id)?.[1];
  return (config?.agents?.list ?? []).find(agent => String(agent?.id ?? "").toLowerCase() === id);
}

// The models this agent may select. The rendered profile catalog binds each
// allowed provider/model reference to the harness that runs it, and the
// instance names short aliases on the global model table.
export function allowedModels(config, agentId) {
  const defaults = config?.agents?.defaults?.models ?? {};
  const agent = configuredAgent(config, agentId);
  const agentModels = agent?.models && typeof agent.models === "object" && !Array.isArray(agent.models) ? agent.models : {};
  const refs = Object.keys(agentModels).length ? Object.keys(agentModels) : config?.agents?.defaults?.modelPolicy?.allow ?? Object.keys(defaults);
  return refs.filter(ref => ref.includes("/")).map(ref => ({ref, alias: defaults[ref]?.alias, harness: agentModels[ref]?.agentRuntime?.id ?? defaults[ref]?.agentRuntime?.id}));
}

export function resolveRequestedModel(models, requested) {
  const query = String(requested ?? "").trim().toLowerCase();
  if (!query) return;
  return models.find(model => model.ref.toLowerCase() === query || model.alias?.toLowerCase() === query || model.ref.toLowerCase().split("/")[1] === query);
}

// Persists the session fields the native /model and /think commands write, so
// the next run in this conversation resolves the new model and its harness.
export async function applySessionSelection({config, sessionKey, agentId, provider, model, reasoning}, sdk) {
  sdk ??= await loadCoreSdk("session-store-runtime");
  const storePath = sdk.resolveStorePath(config?.session?.store, {agentId});
  const updated = await sdk.updateSessionStoreEntry({sessionKey, storePath, update: entry => {
    const next = {...entry, providerOverride: provider, modelOverride: model, modelOverrideSource: "user", modelOverrideRouteResolution: "resolved", liveModelSwitchPending: true, updatedAt: Date.now()};
    for (const stale of ["model", "modelProvider", "contextTokens", "contextTokensSource", "contextBudgetStatus", "modelOverrideFallbackOriginProvider", "modelOverrideFallbackOriginModel"]) delete next[stale];
    if (reasoning) next.thinkingLevel = reasoning;
    return next;
  }});
  if (!updated) throw new Error(`Session ${sessionKey} is not in the store yet; ask again after this turn`);
  return updated;
}

export function switchModelTool(context, {config, apply = applySessionSelection}) {
  if (!context.sessionKey) return;
  const agentId = String(context.agentId ?? context.sessionKey.match(/^agent:([^:]+)/i)?.[1] ?? "").toLowerCase();
  const models = allowedModels(config, agentId);
  if (!models.length) return;
  const options = models.map(model => model.alias ? `${model.alias} (${model.ref})` : model.ref).join(", ");
  return {
    name: "switch_model",
    description: `Switch this conversation to another model, and with it the harness that runs it, when the human asks in their own words. Call it before any other work in that turn. Allowed: ${options}. Reasoning may also be set: ${REASONING.join(", ")}.`,
    parameters: {
      type: "object", additionalProperties: false, required: ["model"],
      properties: {
        model: {type: "string", description: "An alias or provider/model reference from the allowed list."},
        reasoning: {type: "string", enum: REASONING, description: "Optional reasoning level for later turns."},
      },
    },
    async execute(_toolCallId, args) {
      const selected = resolveRequestedModel(models, args?.model);
      if (!selected) return reply(`Unknown model "${args?.model ?? ""}". Allowed: ${options}.`, true);
      if (context.senderIsOwner === false) return reply("Refused: only the owner can switch the model.", true);
      const [provider, model] = selected.ref.split("/");
      try {
        context.assertInvocationCurrent?.();
        await apply({config, sessionKey: context.sessionKey, agentId, provider, model, reasoning: args?.reasoning});
      } catch (error) {
        return reply(String(error?.message ?? error), true);
      }
      const harness = selected.harness ? ` on ${selected.harness}` : "";
      const level = args?.reasoning ? `, reasoning ${args.reasoning}` : "";
      return reply(`Switched to ${selected.ref}${harness}${level}. It applies from the next turn in this conversation; tell the human that in one line.`);
    },
  };
}

export function registerSwitchModelTool(api) {
  api.registerTool?.({contextVersion: 2, create: context => switchModelTool(context, {config: api.config})}, {name: "switch_model"});
}
