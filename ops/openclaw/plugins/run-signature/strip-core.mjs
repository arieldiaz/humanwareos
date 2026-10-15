export const THINKING_TILES = ["think_off", "think_low", "think_medium", "think_high", "think_max", "think_auto"];

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

// Keyed by the harness id the selected execution profile declares.
const HARNESS_TILES = {
  codex: ":h_codex:",
  "claude-cli": ":h_cc:",
  "cursor-agent": ":h_cursor:",
  cursor: ":h_cursor:",
  opencode: ":h_opencode:",
};

export function resolveModelTile(model) {
  const value = String(model ?? "");
  return MODEL_TILES.find(([pattern]) => pattern.test(value))?.[1];
}

export function resolveHarnessTile(harnessId) {
  return Object.hasOwn(HARNESS_TILES, harnessId ?? "") ? HARNESS_TILES[harnessId] : undefined;
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
