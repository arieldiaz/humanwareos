import {randomUUID} from "node:crypto";
import {appendFile, mkdir} from "node:fs/promises";
import {dirname, join} from "node:path";
import {slackRoute} from "./slack-route.mjs";

const STATUS = {
  working: "🔄 Working",
  act: "✋ Act",
  scheduled: "🗓️ Scheduled",
  closed: "✅ Closed",
  unknown: null,
};
const reply = (text, isError) => ({content: [{type: "text", text}], ...(isError ? {isError} : {})});

export function setThreadStatusTool(context, {dataRoot, append = appendFile, makeDir = mkdir, id = randomUUID}) {
  if (context.messageChannel !== "slack" || !context.sessionKey || !dataRoot) return;
  const route = slackRoute({
    channel: context.nativeChannelId,
    threadId: context.deliveryContext?.threadId,
    sessionKey: context.sessionKey,
    origin: context.deliveryContext,
  });
  if (!route) return;
  return {
    name: "set_thread_status",
    description: "Set or clear this Slack root's bot-owned workflow status only when the owner explicitly asks. Use working, act, scheduled, closed, or unknown. This never runs from lifecycle state.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["status"],
      properties: {status: {type: "string", enum: Object.keys(STATUS)}},
    },
    async execute(_toolCallId, params) {
      try {
        context.assertInvocationCurrent?.();
        if (!(params?.status in STATUS)) throw new Error("invalid status");
        const at = new Date().toISOString();
        const command = {
          schemaVersion: 1,
          id: `status-command:${id()}`,
          observedAt: at,
          channelId: route.channel,
          messageTs: route.threadId,
          status: STATUS[params.status],
          requestedBy: context.agentAccountId ?? (String(context.agentId ?? "").toLowerCase() || null),
        };
        const filePath = join(dataRoot, "operations", "slack-notion-sync", "commands.jsonl");
        await makeDir(dirname(filePath), {recursive: true, mode: 0o700});
        await append(filePath, `${JSON.stringify(command)}\n`, {mode: 0o600});
      } catch (error) {
        return reply(String(error?.message ?? error), true);
      }
      return reply(`Queued bot-owned thread status: ${params.status}.`);
    },
  };
}
