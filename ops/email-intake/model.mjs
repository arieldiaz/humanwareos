import {createHash} from "node:crypto";

export function required(value, name, limit = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error(`invalid ${name}`);
  return value.trim();
}

export function instant(value) {
  if (typeof value !== "string" || !/Z$|[+-]\d{2}:\d{2}$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("invalid timestamp");
  return new Date(value).toISOString();
}

export function address(value) {
  const result = required(value, "address", 320).toLowerCase();
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(result)) throw new Error("invalid address");
  return result;
}

// Provider adapters parse RFC headers; this boundary accepts one ID per value.
export function messageId(value) {
  if (value == null) return null;
  const id = required(value, "message ID").replace(/^<([^<>]+)>$/, "$1");
  if (/[\s<>]/.test(id)) throw new Error("invalid message ID");
  return id; // Message-ID local parts are case-sensitive.
}

export function subjectKey(value) {
  return value.normalize("NFKC").replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/i, "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Explicit allowlist: no body field can become policy, domainStatus, or promotion. */
export function normalizeMessage(input) {
  if (!Number.isSafeInteger(input?.sizeBytes) || input.sizeBytes < 0) throw new Error("invalid sizeBytes");
  if (input.references != null && (!Array.isArray(input.references) || input.references.length > 100)) throw new Error("invalid references");
  const subject = input.subject ?? "";
  if (typeof subject !== "string" || subject.length > 998) throw new Error("invalid subject");
  const automatic = input.automatic ?? "none";
  if (!["none", "automated", "bulk", "loop"].includes(automatic)) throw new Error("invalid automatic flag");
  const message = {
    schemaVersion: 1,
    source: required(input.source, "source"),
    deliveryId: required(input.deliveryId, "deliveryId"),
    recipient: address(input.recipient), sender: address(input.sender),
    messageId: messageId(input.messageId), inReplyTo: messageId(input.inReplyTo),
    references: (input.references ?? []).map((id) => required(messageId(id), "reference")),
    subject, subjectKey: subjectKey(subject), receivedAt: instant(input.receivedAt),
    sizeBytes: input.sizeBytes, automatic,
    // References address private evidence; raw MIME, HTML and bodies stay outside this contract.
    evidenceRef: required(input.evidenceRef, "evidenceRef", 2048),
  };
  message.key = digest([message.recipient, message.messageId ? ["message-id", message.messageId] : ["delivery", message.source, message.deliveryId]]);
  return message;
}

export function normalizeReceipt(receipt, key) {
  if (!receipt) return null;
  if (receipt.messageKey !== key || receipt.verified !== true) throw new Error("domain receipt lacks verified message binding");
  if (!["recorded", "cancelled", "duplicate"].includes(receipt.outcome)) throw new Error("invalid domain receipt outcome");
  return {
    domain: required(receipt.domain, "receipt domain"),
    operationId: required(receipt.operationId, "receipt operationId"),
    resourceId: required(receipt.resourceId, "receipt resourceId"),
    outcome: receipt.outcome, verifiedAt: instant(receipt.verifiedAt), messageKey: key,
  };
}

export function classify({receipt, assessment, automatic}) {
  if (receipt) return {intakeClass: "recorded", state: "recorded", domainStatus: "closed"};
  if (automatic !== "none") return {intakeClass: "rejected", state: "rejected", domainStatus: null, diagnostic: "automatic_mail"};
  if (assessment?.bounded === true && assessment?.authorized === true && ["question", "record"].includes(assessment.kind)) {
    return {intakeClass: "quick", state: "working", domainStatus: "working"};
  }
  return {intakeClass: "promotion_requested", state: "awaiting_promotion", domainStatus: "act"};
}

// Intake processing states are separate from the four canonical domainStatus values.
export function handlingTransition(current, event) {
  if (!["working", "answered", "clarify", "act", "scheduled"].includes(current.state)) throw new Error("intake is not in quick handling");
  switch (event.kind) {
    case "answered": return {...current, state: "answered", domainStatus: "act", wake: null};
    case "clarify": return {...current, state: "clarify", domainStatus: "act", wake: null};
    case "act": return {...current, state: "act", domainStatus: "act", wake: null};
    case "resume": return {...current, state: "working", domainStatus: "working", wake: null};
    case "scheduled": return {...current, state: "scheduled", domainStatus: "scheduled", wake: {id: required(event.wake?.id, "durable wake ID"), at: instant(event.wake?.at)}};
    default: throw new Error("unsupported handling event");
  }
}
