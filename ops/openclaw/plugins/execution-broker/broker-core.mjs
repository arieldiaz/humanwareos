const CONTROL_WORDS = /\b(use|using|via|with|switch|change|set|profile|model|harness|runtime|thinking|reasoning|effort|fast|slow|style|concise|detailed|brainstorm|workspace|task|general)\b/i;
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function normalize(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[_\s]+/g, "-");
}

function enabledProfiles(catalog) {
  return Object.entries(catalog?.profiles ?? {}).filter(([, profile]) => profile?.enabled !== false);
}

function exactProfile(prefix, catalog) {
  const match = prefix.match(/\bprofile\s*(?:=|:)\s*([a-z0-9._-]+)/i);
  if (match) return match[1];
  const normalizedPrefix = normalize(prefix);
  return enabledProfiles(catalog).find(([id]) => normalizedPrefix === normalize(id))?.[0];
}

function inferProfile(prefix, catalog, allowed, preferredProfileId) {
  const source = normalize(prefix);
  const level = LEVELS.find((candidate) => new RegExp(`(?:^|-)${candidate}(?:-|$)`).test(source));
  const executionMode = ["general", "task", "workspace"].find((candidate) => new RegExp(`(?:^|-)${candidate}(?:-|$)`).test(source));
  const modeRank = new Map([["general", 0], ["task", 1], ["workspace", 2]]);
  const levelRank = new Map(LEVELS.map((item, index) => [item, index]));
  const modifierWords = new Set(["use", "using", "via", "with", "switch", "change", "set", "to", "the", "profile", "model", "harness", "runtime", "thinking", "reasoning", "effort", "fast", "slow", "style", "concise", "detailed", "brainstorm", "general", "task", "workspace", ...LEVELS]);
  const modifierOnly = source.split("-").filter(Boolean).every((word) => modifierWords.has(word));
  const preferred = catalog.profiles?.[preferredProfileId];
  let candidates = enabledProfiles(catalog)
    .filter(([id]) => allowed.includes(id))
    .map(([id, profile]) => {
      const aliases = [id, profile.family, profile.harness, profile.model, ...(profile.aliases ?? [])]
        .filter(Boolean)
        .map(normalize);
      const score = aliases.reduce((total, alias) => {
        if (!alias) return total;
        if (source.includes(alias)) return total + Math.max(3, alias.split("-").length);
        return total + alias.split("-").filter((part) => part.length > 2 && source.includes(part)).length;
      }, 0);
      return {id, profile, score};
    });
  if (!candidates.some((entry) => entry.score > 0) && preferred && modifierOnly) {
    candidates = candidates.map((entry) => ({
      ...entry,
      score: entry.profile.family === preferred.family || entry.profile.harness === preferred.harness ? 1 : 0,
    }));
  }
  candidates = candidates
    .filter((entry) => entry.score > 0)
    .filter((entry) => !level || normalize(entry.profile.reasoning) === level)
    .filter((entry) => !executionMode || normalize(entry.profile.executionMode) === executionMode)
    .sort((a, b) => b.score - a.score
      || (modeRank.get(normalize(a.profile.executionMode)) ?? 99) - (modeRank.get(normalize(b.profile.executionMode)) ?? 99)
      || (levelRank.get(normalize(a.profile.reasoning)) ?? 99) - (levelRank.get(normalize(b.profile.reasoning)) ?? 99)
      || a.id.localeCompare(b.id));
  return candidates[0]?.id;
}

function parseControlEnvelope(input) {
  const original = String(input ?? "").trim();
  const withoutMention = original.replace(/^<@[A-Z0-9]+>\s*/i, "").replace(/^@[A-Za-z][\w-]*\s*/i, "");
  const colon = withoutMention.indexOf(":");
  if (colon < 0) return {explicit: false, prefix: "", task: original};
  const prefix = withoutMention.slice(0, colon).trim();
  if (!CONTROL_WORDS.test(prefix) && !/\bprofile\s*=/.test(prefix)) return {explicit: false, prefix: "", task: original};
  return {explicit: true, prefix, task: withoutMention.slice(colon + 1).trim()};
}

export function extractIntents(task, limit = 8) {
  const source = String(task ?? "").trim();
  if (!source) return [];
  const bulletParts = source.split(/\n(?=\s*(?:[-*]|\d+[.)])\s+)/).map((part) => part.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim());
  const sentenceParts = bulletParts.flatMap((part) => {
    const clauses = part.split(/(?<=[?!;])\s+|\s+(?:and also|also|plus|as well as)\s+|,\s+and\s+|\s+and\s+(?=(?:please|can|could|would|i\s+(?:want|need|would\s+like))\b)/i);
    return clauses.flatMap((clause) => {
      const commaParts = clause.split(/,\s+/).map((item) => item.trim()).filter(Boolean);
      return commaParts.length >= 3 ? commaParts : [clause];
    });
  });
  const intents = sentenceParts.map((part) => part.trim().replace(/^(?:and\s+)?also\s+/i, "")).filter((part) => part.length > 2);
  return (intents.length ? intents : [source]).slice(0, limit).map((text, index) => ({id: index + 1, text}));
}

export function resolveExecutionPlan({input, catalog, agentId, channelId, conversationId, persistedProfile}) {
  if (catalog?.schemaVersion !== 2) throw new Error("execution profile catalog must use schemaVersion 2");
  const policy = catalog?.agents?.[agentId];
  if (!policy) throw new Error(`no execution policy for agent ${agentId}`);
  const allowed = policy.allowedProfiles ?? [];
  const envelope = parseControlEnvelope(input);
  let profileId;
  let source;
  if (envelope.explicit) {
    if (!envelope.task) throw new Error("the execution directive needs a task after ':'");
    profileId = exactProfile(envelope.prefix, catalog) ?? inferProfile(envelope.prefix, catalog, allowed, persistedProfile ?? policy.defaultProfile ?? catalog.defaultProfile);
    if (!profileId) throw new Error(`unsupported execution directive: ${envelope.prefix}`);
    source = "explicit";
  } else if (persistedProfile) {
    profileId = persistedProfile;
    source = "thread";
  } else if (conversationId && policy.channelDefaults?.[`${channelId}:${conversationId}`]) {
    profileId = policy.channelDefaults[`${channelId}:${conversationId}`];
    source = "conversation";
  } else if (policy.channelDefaults?.[channelId]) {
    profileId = policy.channelDefaults[channelId];
    source = "channel";
  } else if (policy.defaultProfile) {
    profileId = policy.defaultProfile;
    source = "agent";
  } else {
    profileId = catalog.defaultProfile;
    source = "system";
  }
  if (!allowed.includes(profileId)) throw new Error(`profile ${profileId} is not allowed for ${agentId}`);
  const profile = catalog.profiles?.[profileId];
  if (!profile || profile.enabled === false) throw new Error(`profile ${profileId} is unavailable`);
  const style = envelope.explicit
    ? ["concise", "detailed", "brainstorm"].filter((item) => new RegExp(`\\b${item}\\b`, "i").test(envelope.prefix))
    : [];
  return {
    agentId,
    profileId,
    profile,
    source,
    explicit: envelope.explicit,
    control: envelope.prefix,
    task: envelope.task,
    style,
    intents: extractIntents(envelope.task),
  };
}

export function renderCoverageContext(plan) {
  const ledger = plan.intents.map((intent) => `${intent.id}. ${intent.text}`).join("\n");
  return [
    "Execution control was resolved by the Humanware broker before this model call.",
    `Effective profile: ${plan.profileId}; harness=${plan.profile.harness}; model=${plan.profile.model}; reasoning=${plan.profile.reasoning ?? "default"}; fast=${String(plan.profile.fastMode ?? "default")}.`,
    plan.style.length ? `Requested response style: ${plan.style.join(", ")}.` : "",
    "Treat the leading routing phrase in the user message as applied control metadata, not as an unanswered request.",
    "Request coverage ledger (address, explicitly defer, or explain the blocker for every item):",
    ledger,
  ].filter(Boolean).join("\n");
}
