const MODEL_LABELS = [
  [/opus/i, "🟣 Opus"], [/sonnet/i, "🔵 Sonnet"], [/haiku/i, "🟡 Haiku"],
  [/sol/i, "🟢 Sol"], [/terra/i, "🟤 Terra"], [/luna/i, "⚪ Luna"],
  [/grok/i, "⚫ Grok"], [/qwen/i, "🟠 Qwen"], [/llama/i, "🦙 Llama"],
];
const HARNESS_LABELS = [
  [/codex/i, "⌘ Codex"], [/cursor/i, "⌁ Cursor"], [/claude/i, "◆ Claude Code"], [/opencode/i, "◇ OpenCode"],
];

export function renderRunSignature({ model, provider, harnessId, thinkLevel } = {}) {
  const modelLabel = MODEL_LABELS.find(([pattern]) => pattern.test(String(model ?? "")))?.[1];
  const harnessValue = [harnessId, provider].filter(Boolean).join("/");
  const harnessLabel = HARNESS_LABELS.find(([pattern]) => pattern.test(harnessValue))?.[1];
  const thinking = String(thinkLevel ?? "").trim().toLowerCase();
  const thinkingLabel = thinking ? `💭 ${thinking[0].toUpperCase()}${thinking.slice(1)}` : undefined;
  return [modelLabel, harnessLabel, thinkingLabel].filter(Boolean).join(" · ");
}
