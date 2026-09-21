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
  done: "white_check_mark",
});
export const ADMITTED_STATUS = "working";

const OUTBOUND_STATUSES = new Set(["act", "working", "scheduled", "done"]);
const LIFECYCLE_HEADING_STATUS = [
  ["act", /^## ✋ Act\s*$/m],
  ["scheduled", /^## 🗓️ Scheduled\s*$/m],
  ["done", /^## Session Closed\s*$/m],
];

function lifecycleHeadingStatus(content) {
  const source = String(content ?? "");
  let status;
  let lastIndex = -1;
  for (const [name, pattern] of LIFECYCLE_HEADING_STATUS) {
    const re = new RegExp(pattern.source, "gm");
    let match;
    while ((match = re.exec(source)) !== null) {
      if (match.index >= lastIndex) {
        lastIndex = match.index;
        status = name;
      }
    }
  }
  return status;
}

// Typed status wins. Otherwise only an exact lifecycle heading is semantic;
// arbitrary prose and retired transport footers never manufacture an obligation.
export function normalizeOutboundStatus(content, { explicitStatus } = {}) {
  const source = String(content ?? "").trim();
  const typed = OUTBOUND_STATUSES.has(explicitStatus) ? explicitStatus : undefined;
  return {
    status: typed ?? lifecycleHeadingStatus(source) ?? "done",
    closeRequested: /^## Session Closed\s*$/m.test(source),
    content: source,
  };
}

// A ✅ the human placed is the thread's done state, and a bot cannot remove
// another user's reaction anyway. `botUserIds` is every gateway-controlled bot
// user id — the other agent's ✅ is a bot close, not a human one.
export function resolveStatusTile(outboundStatus, rawReactions, botUserIds) {
  const bots = botUserIds instanceof Set ? botUserIds : new Set([botUserIds].filter(Boolean));
  const reactions = normalizeReactions(rawReactions);
  const humanDone = reactions?.find((item) =>
    item?.name === "white_check_mark" &&
    Array.isArray(item?.users) &&
    item.users.some((user) => !bots.has(user)));
  return humanDone ? "white_check_mark" : OUTBOUND_STATUS_TO_TILE[outboundStatus];
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
// Forward cleanup rides along: any gateway-held tile from the retired
// provenance-strip era is removed the next time its thread sees a send, each
// with the token that holds it. A tile a human holds is never touched, and a
// human-held lifecycle tile owns the state outright — the bot adds nothing
// beside it. Reactions outside the strip vocabulary are never touched.
export function planStatusTile(rawReactions, { lifecycle, sendingBotId, botUserIds }) {
  const bots = botUserIds instanceof Set ? botUserIds : new Set([...(botUserIds ?? []), sendingBotId].filter(Boolean));
  const entries = normalizeReactions(rawReactions)
    .filter((item) => STRIP_NAME_SET.has(item?.name))
    .map((item) => {
      const users = Array.isArray(item.users) ? item.users : [];
      return {
        name: item.name,
        kind: tileKind(item.name),
        botHolders: users.filter((user) => bots.has(user)),
        humanHeld: users.some((user) => !bots.has(user)),
      };
    });

  const humanStatus = entries.some((entry) => LIFECYCLE_NAMES.includes(entry.name) && entry.humanHeld);
  const desired = humanStatus ? undefined : lifecycle;

  const remove = entries
    .filter((entry) => entry.botHolders.length && entry.name !== desired)
    .map((entry) => ({ name: entry.name, holders: entry.botHolders }));
  const present = entries.some((entry) => entry.name === desired && entry.botHolders.length);
  const add = desired && !present ? [{ name: desired, holders: [sendingBotId] }] : [];
  return { unchanged: !remove.length && !add.length, remove, add };
}
