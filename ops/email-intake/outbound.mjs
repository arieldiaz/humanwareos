import {address, digest, required} from "./model.mjs";

export const MAX_RECIPIENTS = 10;
export const MAX_TEXT = 32768;

function addresses(values) {
  return [...new Set((values ?? []).map(address))];
}

function header(id) { return `<${id}>`; }

/**
 * Normalizes an agent-authored plain-text message. Only declared senders may
 * appear in From; anything addressed beyond the owner mailbox needs approval.
 * A reply copies ancestry from the intake message so the answer stays in thread.
 */
export function outboundDraft(input, {id, senders, ownerMailbox, ownDomains = [], replyTo = null, thread = null, createdAt}) {
  const from = address(input.from ?? replyTo?.recipient ?? "");
  if (!senders.map(address).includes(from)) throw new Error("undeclared_sender");
  const to = addresses(input.to), cc = addresses(input.cc).filter((value) => !to.includes(value));
  const recipients = [...to, ...cc];
  if (!to.length || recipients.length > MAX_RECIPIENTS) throw new Error("invalid_recipients");
  // Our own routed domains loop back into intake; an agent never mails itself.
  if (recipients.some((value) => ownDomains.includes(value.split("@")[1]))) throw new Error("own_domain_recipient");
  const prior = replyTo?.subject ?? "";
  const subject = input.subject ?? (/^re:/i.test(prior) ? prior : `Re: ${prior}`);
  if (typeof subject !== "string" || !subject.trim() || subject.length > 998 || /[\r\n]/.test(subject)) throw new Error("invalid_subject");
  if (typeof input.text !== "string" || !input.text.trim() || input.text.length > MAX_TEXT) throw new Error("invalid_text");
  const threading = replyTo?.messageId ? {inReplyTo: replyTo.messageId, references: [...replyTo.references, replyTo.messageId].slice(-20)} : {inReplyTo: null, references: []};
  const owner = address(ownerMailbox);
  const content = {schemaVersion: 1, id: required(id, "draft ID"), from, to, cc, subject, text: input.text, ...threading,
    intakeId: replyTo?.intakeId ?? null, thread, createdAt};
  const approvalRequired = recipients.some((value) => value !== owner);
  if (approvalRequired && !thread) throw new Error("approval_thread_required");
  const code = digest(content).slice(0, 8);
  return {...content, approvalRequired, code};
}

export function approvalPhrase(draft) { return `approve email ${draft.code}`; }

/** True only for the declared human's own Slack message, after the preview, with the exact phrase. */
export function isApproval(message, draft, {approverId, previewTs}) {
  return Boolean(message) && !message.bot_id && !message.subtype && message.user === required(approverId, "approver")
    && Number(message.ts) > Number(required(previewTs, "preview timestamp"))
    && String(message.text ?? "").trim().replace(/\s+/g, " ").toLowerCase() === approvalPhrase(draft);
}

/** Exact Slack preview of what will be sent; approval binds to this content's code. */
export function previewText(draft) {
  return [`Email draft ${draft.code} from ${draft.from} needs approval.`, `To: ${draft.to.join(", ")}`,
    ...(draft.cc.length ? [`Cc: ${draft.cc.join(", ")}`] : []), `Subject: ${draft.subject}`,
    ...(draft.inReplyTo ? ["Threaded as a reply to the intake message."] : []), "", draft.text, "",
    `Reply "${approvalPhrase(draft)}" in this thread to send it exactly as shown.`].join("\n");
}

/** Provider-neutral request body; matches the Cloudflare Email Sending REST schema. */
export function sendRequest(draft, label) {
  const headers = draft.inReplyTo ? {"In-Reply-To": header(draft.inReplyTo), References: draft.references.map(header).join(" ")} : undefined;
  return {from: label ? {address: draft.from, name: label} : draft.from, to: draft.to, ...(draft.cc.length ? {cc: draft.cc} : {}),
    subject: draft.subject, text: draft.text, ...(headers ? {headers} : {})};
}
