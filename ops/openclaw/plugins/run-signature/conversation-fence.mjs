function normalizeChannel(value) {
  const channel = String(value ?? "").replace(/^channel:/i, "").toUpperCase();
  return /^[CDG][A-Z0-9]+$/.test(channel) ? channel : undefined;
}

function normalizeThread(value) {
  const thread = String(value ?? "").trim();
  return /^\d{10}\.\d{6}$/.test(thread) ? thread : undefined;
}

export function conversationFenceRoute({ channel, threadId, sessionKey, origin } = {}) {
  const sessionMatch = String(sessionKey ?? "").match(/:slack:channel:([^:]+):thread:([^:]+)$/i);
  const resolvedChannel = normalizeChannel(channel ?? origin?.nativeChannelId ?? origin?.channelId ?? origin?.to ?? sessionMatch?.[1]);
  const resolvedThread = normalizeThread(threadId ?? origin?.threadId ?? origin?.replyToId ?? sessionMatch?.[2]);
  if (!resolvedChannel || !resolvedThread) return;
  return { channel: resolvedChannel, threadId: resolvedThread };
}

export function conversationFenceKey(route) {
  const resolved = conversationFenceRoute(route);
  return resolved ? `slack:${resolved.channel}:${resolved.threadId}` : undefined;
}
