const EVENT_SCHEMA_VERSION = 1;
export function normalizeAddress(value) {
  return String(value || "").trim().toLowerCase();
}

export function parseAddressHeader(value) {
  const text = String(value || "").trim();
  const bracketed = text.match(/<([^<>\s]+@[^<>\s]+)>/);
  const plain = text.match(/(?:^|\s)([^\s<>,;]+@[^\s<>,;]+)(?:$|\s)/);
  return normalizeAddress(bracketed?.[1] || plain?.[1] || text);
}

export function parseAllowedRecipients(value) {
  return new Set(String(value || "").split(",").map(normalizeAddress).filter(Boolean));
}

export function parseMessageIds(value) {
  return (String(value || "").match(/<[^<>\s]+>/g) || []).slice(-100);
}

export function buildEvent(message, now = new Date()) {
  const eventId = crypto.randomUUID();
  const headerFrom = parseAddressHeader(message.headers.get("from"));
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId,
    deliveryId: eventId,
    sender: normalizeAddress(message.from),
    sizeBytes: Number(message.rawSize || 0),
    source: "cloudflare-email-routing",
    receivedAt: now.toISOString(),
    envelopeFrom: normalizeAddress(message.from),
    replyTo: headerFrom || normalizeAddress(message.from),
    recipient: normalizeAddress(message.to),
    subject: String(message.headers.get("subject") || "").slice(0, 998),
    messageId: String(message.headers.get("message-id") || "").slice(0, 998),
    inReplyTo: parseMessageIds(message.headers.get("in-reply-to")).at(-1) ?? null,
    references: parseMessageIds(message.headers.get("references")),
    autoSubmitted: String(message.headers.get("auto-submitted") || "").slice(0, 128),
    precedence: String(message.headers.get("precedence") || "").slice(0, 128),
    rawSize: Number(message.rawSize || 0)
  };
}

// Raw MIME is stored in R2 under its SHA-256, which is also the delivery ID:
// stable across provider redelivery even without a Message-ID. Only this
// pointer and bounded envelope metadata are queued.
export async function readRaw(message, now = new Date()) {
  const raw = await new Response(message.raw).arrayBuffer();
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)), byte => byte.toString(16).padStart(2, '0')).join('');
  return {raw, event: {...buildEvent(message, now), deliveryId: sha256, rawSha256: sha256, sizeBytes: raw.byteLength, rawSize: raw.byteLength}};
}

async function handleEmail(message, env) {
  const recipient = normalizeAddress(message.to);
  const allowed = parseAllowedRecipients(env.ALLOWED_RECIPIENTS);
  if (!allowed.has(recipient)) {
    message.setReject("550 5.1.1 Recipient not configured");
    return;
  }
  const maxRawBytes = Number(env.MAX_RAW_BYTES);
  if (!Number.isSafeInteger(maxRawBytes) || maxRawBytes <= 0) throw new Error("MAX_RAW_BYTES unconfigured");
  if (!env.EMAIL_RAW || !env.EMAIL_EVENTS) throw new Error("EMAIL_RAW bucket or EMAIL_EVENTS queue unavailable");
  if (Number(message.rawSize || 0) > maxRawBytes) {
    message.setReject("552 5.3.4 Message too large");
    return;
  }
  const {raw, event} = await readRaw(message);
  if (raw.byteLength > maxRawBytes || new TextEncoder().encode(JSON.stringify(event)).length > 128 * 1024) {
    message.setReject("552 5.3.4 Message too large");
    return;
  }
  // The object must exist before its pointer is queued. The local intake
  // deletes it after committing the bytes to private evidence.
  await env.EMAIL_RAW.put(event.rawSha256, raw);
  await env.EMAIL_EVENTS.send(event, {contentType: "json"});
}

export default {
  async fetch(request, env = {}) {
    return Response.json({ ok: true, service: env.SERVICE_NAME || "agent-email" });
  },
  email: handleEmail
};
