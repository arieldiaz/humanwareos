// The one implementation of the run-strip vocabulary and planner. The plugin,
// the sweep, and the audit import from here; a second copy of any table or
// ordering rule in another file is the drift this module exists to end.

export const THINKING_TILES = ["think_off", "think_low", "think_medium", "think_high", "think_max", "think_auto"];
export const LIFECYCLE_NAMES = ["arrows_counterclockwise", "raised_hand", "calendar", "white_check_mark"];
export const RETIRED_LIFECYCLE_NAMES = ["question", "arrow_forward", "no_entry_sign"];
export const AGENT_NAMES = ["butterfly", "fox_face"];
export const STRIP_NAMES = [...LIFECYCLE_NAMES, ...RETIRED_LIFECYCLE_NAMES, ...AGENT_NAMES, "h_codex", "h_cc", "h_cursor", "h_opencode", "m_opus", "m_sonnet", "m_haiku", "m_fable", "stars", "m_gpt_sol", "m_gpt_terra", "m_gpt_luna", "m_cursor_auto", "m_grok", "m_qwen_moe", "m_qwen_dense", "m_llama", ...THINKING_TILES];
export const STRIP_NAME_SET = new Set(STRIP_NAMES);

// Slack stores a reaction under its own canonical name, not the alias it was
// added with. ✋ goes out as `raised_hand` and reads back as `hand`, which is
// not in the strip vocabulary — normalize on read or the tile is invisible to
// every comparison.
const READ_ALIASES = new Map([["hand", "raised_hand"]]);

export function normalizeReactions(reactions) {
  return (reactions ?? []).map((item) => {
    const canonical = READ_ALIASES.get(item?.name);
    return canonical ? { ...item, name: canonical } : item;
  });
}

const MODEL_TILES = [
  [/opus/i, ":m_opus:"],
  [/sonnet/i, ":m_sonnet:"],
  [/haiku/i, ":m_haiku:"],
  [/fable/i, ":m_fable:"],
  [/(?:gpt[-_. ]?6[-_. ]?)?astra/i, ":stars:"],
  [/(?:gpt[-_. ]?5\.?6[-_. ]?)?sol/i, ":m_gpt_sol:"],
  [/(?:gpt[-_. ]?5\.?6[-_. ]?)?terra/i, ":m_gpt_terra:"],
  [/(?:gpt[-_. ]?5\.?6[-_. ]?)?luna/i, ":m_gpt_luna:"],
  [/grok/i, ":m_grok:"],
  [/(?:cursor[/:_. -]+)?auto$/i, ":m_cursor_auto:"],
  [/qwen.*(?:moe|a3b)/i, ":m_qwen_moe:"],
  [/qwen/i, ":m_qwen_dense:"],
  [/llama/i, ":m_llama:"],
];

const HARNESS_TILES = [
  [/(?:^|[:/])codex(?:$|[:/])|codex-thread/i, ":h_codex:"],
  [/(?:claude|acp).*claude|claude[-_. ]?code|claude[-_. ]?cli/i, ":h_cc:"],
  [/cursor/i, ":h_cursor:"],
  [/opencode/i, ":h_opencode:"],
];

export function resolveModelTile(model) {
  const value = String(model ?? "");
  return MODEL_TILES.find(([pattern]) => pattern.test(value))?.[1];
}

export function resolveHarnessTile({ harnessId, provider, sessionKey } = {}) {
  const value = [harnessId, provider, sessionKey].filter(Boolean).join("/");
  return HARNESS_TILES.find(([pattern]) => pattern.test(value))?.[1];
}

export function normalizeThinkingLevel(value) {
  const level = String(value ?? "").trim().toLowerCase();
  if (["none", "disabled", "off"].includes(level)) return "off";
  if (["minimal", "low"].includes(level)) return "low";
  if (level === "medium") return "medium";
  if (level === "high") return "high";
  if (["xhigh", "max", "ultra"].includes(level)) return "max";
  if (["default", "unset", "adaptive", "auto"].includes(level)) return "auto";
}

export function resolveThinkingTile({ thinkLevel, reasoningLevel, reasoningEffort }) {
  const normalized = normalizeThinkingLevel(thinkLevel ?? reasoningLevel ?? reasoningEffort);
  return normalized ? `:think_${normalized}:` : undefined;
}

export const OUTBOUND_STATUS_TO_TILE = Object.freeze({
  act: "raised_hand",
  working: "arrows_counterclockwise",
  scheduled: "calendar",
  closed: "white_check_mark",
});
export const ADMITTED_STATUS = "working";

export function resolveStatusTile(outboundStatus) {
  return OUTBOUND_STATUS_TO_TILE[outboundStatus];
}

export function tileKind(name) {
  if (LIFECYCLE_NAMES.includes(name) || RETIRED_LIFECYCLE_NAMES.includes(name)) return "lifecycle";
  if (AGENT_NAMES.includes(name)) return "agent";
  if (name?.startsWith?.("h_")) return "harness";
  if (name?.startsWith?.("m_")) return "model";
  if (name?.startsWith?.("think_")) return "thinking";
}

// The root carries exactly one gateway-held tile: the lifecycle status.
// Provenance (runtime/model/harness/thinking) lives in the per-message run
// signature, because it changes mid-thread and the reply's author already
// names the agent — a root copy is wrong by construction. With one tile there
// is no order contract and nothing to re-lay.
//
// Only bot-owned canonical lifecycle reactions are projected. Human reactions
// are social input and neither suppress nor override the committed decision.
export function planStatusTile(rawReactions, { lifecycle, sendingBotId, botUserIds }) {
  const bots = botUserIds instanceof Set ? botUserIds : new Set([...(botUserIds ?? []), sendingBotId].filter(Boolean));
  const entries = normalizeReactions(rawReactions)
    .filter((item) => LIFECYCLE_NAMES.includes(item?.name))
    .map((item) => {
      const users = Array.isArray(item.users) ? item.users : [];
      return {
        name: item.name,
        kind: tileKind(item.name),
        botHolders: users.filter((user) => bots.has(user)),
        humanHeld: users.some((user) => !bots.has(user)),
      };
    });

  const desired = lifecycle;

  const remove = entries
    .filter((entry) => entry.botHolders.length && entry.name !== desired)
    .map((entry) => ({ name: entry.name, holders: entry.botHolders }));
  const present = entries.some((entry) => entry.name === desired && entry.botHolders.length);
  const add = desired && !present ? [{ name: desired, holders: [sendingBotId] }] : [];
  return { unchanged: !remove.length && !add.length, remove, add };
}
