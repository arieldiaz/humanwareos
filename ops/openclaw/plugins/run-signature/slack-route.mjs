function normalizeChannel(value) {
  const channel = String(value ?? "").replace(/^channel:/i, "").toUpperCase();
  return /^[CDG][A-Z0-9]+$/.test(channel) ? channel : undefined;
}

function normalizeThread(value) {
  const thread = String(value ?? "").trim();
  return /^\d{10}\.\d{6}$/.test(thread) ? thread : undefined;
}

export function slackRouteFromSessionKey(sessionKey) {
  const match = String(sessionKey ?? "").match(/:slack:(?:channel|group):([^:]+):thread:([^:]+)$/i);
  if (!match) return;
  const channel = normalizeChannel(match[1]);
  const rootTs = normalizeThread(match[2]);
  return channel ? {channel, rootTs} : undefined;
}

export function resolveSlackChannel({channel, sessionKey, origin} = {}) {
  const sessionChannel = slackRouteFromSessionKey(sessionKey)?.channel;
  for (const candidate of [channel, origin?.nativeChannelId, origin?.channelId, origin?.conversationId, origin?.to, sessionChannel]) {
    const resolved = normalizeChannel(candidate);
    if (resolved) return resolved;
  }
}

// The Slack thread a session or delivery context belongs to: channel plus root ts.
export function slackRoute({channel, threadId, sessionKey, origin} = {}) {
  const sessionRoute = slackRouteFromSessionKey(sessionKey);
  const resolvedChannel = resolveSlackChannel({channel, sessionKey, origin});
  const resolvedThread = normalizeThread(threadId ?? origin?.threadId ?? origin?.replyToId ?? sessionRoute?.rootTs);
  if (!resolvedChannel || !resolvedThread) return;
  return {channel: resolvedChannel, threadId: resolvedThread};
}

export function slackRouteKey(route) {
  const resolved = slackRoute(route);
  return resolved ? `slack:${resolved.channel}:${resolved.threadId}` : undefined;
}
