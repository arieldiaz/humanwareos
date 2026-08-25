export function buildCursorCliBackends(command) {
  const common = {
    command,
    output: "jsonl",
    resumeOutput: "jsonl",
    jsonlDialect: "claude-stream-json",
    input: "arg",
    modelArg: "--model",
    modelAliases: {
      "grok-4.6-low-fast": "grok-4.6[effort=low,fast=true]",
      "grok-4.6-high-fast": "grok-4.6[effort=high,fast=true]"
    },
    sessionMode: "existing",
    sessionIdFields: ["session_id"],
    freshSessionRecovery: "invalidated-only",
    serialize: false
  };
  return [
    {
      id: "cursor-ask",
      liveTest: {defaultModelRef: "cursor-ask/grok-4.6-low-fast", defaultImageProbe: false, defaultMcpProbe: false},
      nativeToolMode: "always-on",
      config: {
        ...common,
        args: ["--trust", "--mode", "ask", "--print", "--output-format", "stream-json"],
        resumeArgs: ["--trust", "--mode", "ask", "--print", "--output-format", "stream-json", "--resume", "{sessionId}"]
      }
    },
    {
      id: "cursor-agent",
      liveTest: {defaultModelRef: "cursor-agent/grok-4.6-low-fast", defaultImageProbe: false, defaultMcpProbe: false},
      nativeToolMode: "always-on",
      config: {
        ...common,
        // Keep this explicit. Cursor's CLI default is vendor-controlled, while
        // a Humanware workspace profile promises an agentic tool surface.
        args: ["--trust", "--mode", "agent", "--auto-review", "--sandbox", "enabled", "--print", "--output-format", "stream-json"],
        resumeArgs: ["--trust", "--mode", "agent", "--auto-review", "--sandbox", "enabled", "--print", "--output-format", "stream-json", "--resume", "{sessionId}"]
      }
    }
  ];
}

export default {
  id: "cursor-cli",
  name: "Cursor CLI Backends",
  description: "Runs Cursor/Grok through the authenticated Cursor CLI with resumable JSONL sessions.",
  register(api) {
    const command = String(api.pluginConfig?.command ?? "");
    if (!command) throw new Error("cursor-cli requires plugin config command");
    for (const backend of buildCursorCliBackends(command)) api.registerCliBackend(backend);
  }
};
