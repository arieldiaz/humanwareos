import {randomUUID} from 'node:crypto';
import {approvalPhrase, isApproval, outboundDraft, previewText, sendRequest} from './framework.mjs';
import {boundedCall} from './slack.mjs';

const fail = (code) => { throw new Error(code); };

/** Cloudflare Email Sending REST. A 4xx API refusal is definitive; anything else is unknown. */
export function cloudflareSender({accountId, token, fetcher = fetch}) {
  if (!/^[0-9a-f]{32}$/.test(accountId ?? '') || !token) fail('sending_credentials_missing');
  return async (body) => {
    let response, payload;
    try {
      response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${accountId}/email/sending/send`, {method: 'POST',
        headers: {authorization: `Bearer ${token}`, 'content-type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(30000)});
      payload = await response.json();
    } catch { return {outcome: 'unknown'}; }
    const r = payload?.result ?? {};
    if (response.ok && payload?.success === true) return {outcome: 'sent', messageId: r.message_id ?? null, delivered: r.delivered ?? [], queued: r.queued ?? [], permanentBounces: r.permanent_bounces ?? [], suppressed: r.suppressed_recipients ?? []};
    if (response.status >= 400 && response.status < 500 && payload?.success === false) {
      return {outcome: 'rejected', status: response.status, errors: (payload.errors ?? []).slice(0, 5).map((e) => ({code: e.code, message: String(e.message ?? '').slice(0, 200)}))};
    }
    return {outcome: 'unknown', status: response.status};
  };
}

export function parseThread(value) {
  if (value == null) return null;
  const match = /^([CG][A-Z0-9]{2,30}):(\d{6,12}\.\d{1,8})$/.exec(String(value));
  return match ? {channelId: match[1], threadTs: match[2]} : fail('invalid_thread');
}

function summary(record) {
  const {id, status, draft, result} = record;
  return {id, status, from: draft.from, to: draft.to, cc: draft.cc, subject: draft.subject,
    ...(status === 'awaiting_approval' ? {approvalPhrase: approvalPhrase(draft)} : {}), ...(result ? {result} : {})};
}

/**
 * Agent-facing outbound mail. Drafts addressed beyond the owner are previewed
 * verbatim in Slack and sent only after the declared human replies with the
 * draft's approval phrase. Every draft and provider result stays in SQLite.
 */
export class Outbound {
  constructor({store, config, tokens, send, call = boundedCall, newId = randomUUID, now = () => new Date().toISOString()}) {
    const outbound = config.outbound ?? fail('outbound_not_configured');
    Object.assign(this, {store, config, outbound, tokens, sendMail: send, call, newId, now});
  }

  async draft(input) {
    const repository = this.store.repository, thread = parseThread(input.thread);
    let replyTo = null;
    if (input.reply) {
      const conversation = thread && repository.byIntakeThread(thread.channelId, thread.threadTs);
      if (!conversation) fail('unknown_intake_thread');
      replyTo = {...repository.latestMessage(conversation.intakeId), intakeId: conversation.intakeId};
    }
    const ownDomains = [...new Set(Object.keys(this.config.routes).map((a) => a.split('@')[1].toLowerCase()))];
    const draft = outboundDraft(input, {id: this.newId(), senders: this.outbound.senders ?? [], ownerMailbox: this.config.ownerMailbox,
      ownDomains, replyTo, thread, createdAt: this.now()});
    if (!draft.approvalRequired) {
      this.store.addOutbound(draft, 'approved', {method: 'owner_recipient'});
      return summary(this.store.outbound(draft.id));
    }
    const token = this.tokens[this.config.routes[draft.from]] ?? fail('slack_credentials_missing');
    const posted = await this.call('chat.postMessage', token, {channel: thread.channelId, thread_ts: thread.threadTs, text: previewText(draft),
      mrkdwn: false, parse: 'none', unfurl_links: false, unfurl_media: false});
    if (!posted?.ts || posted.channel !== thread.channelId) fail('slack_confirmation_missing');
    this.store.addOutbound(draft, 'awaiting_approval', {method: 'slack_reply', previewTs: posted.ts});
    return summary(this.store.outbound(draft.id));
  }

  async approval(record) {
    const {draft, approval} = record, token = this.tokens[this.config.routes[draft.from]] ?? fail('slack_credentials_missing');
    let cursor;
    do {
      const page = await this.call('conversations.replies', token, {channel: draft.thread.channelId, ts: draft.thread.threadTs, oldest: approval.previewTs, limit: 200, cursor});
      const found = page.messages?.find((m) => isApproval(m, draft, {approverId: this.outbound.approverSlackUserId, previewTs: approval.previewTs}));
      if (found) return {...approval, approverId: found.user, approvalTs: found.ts};
      cursor = page.response_metadata?.next_cursor;
    } while (cursor);
    return null;
  }

  async send(id) {
    let record = this.store.outbound(id) ?? fail('unknown_draft');
    if (['sent', 'rejected'].includes(record.status)) return summary(record);
    // Never repeat a send whose provider outcome is unknown; reconcile in the Cloudflare activity log.
    if (record.status === 'sending') fail('ambiguous_outbound_send');
    if (record.status === 'awaiting_approval') {
      const approval = await this.approval(record);
      if (!approval) return summary(record);
      this.store.transitionOutbound(id, 'awaiting_approval', 'approved', {approval});
    }
    if (!this.store.transitionOutbound(id, 'approved', 'sending')) fail('send_claim_lost');
    record = this.store.outbound(id);
    const result = await this.sendMail(sendRequest(record.draft, this.config.labels?.[record.draft.from]));
    if (result.outcome === 'unknown') {
      this.store.fault(`outbound:${id}`, 'ambiguous_outbound_send');
      fail('ambiguous_outbound_send');
    }
    this.store.transitionOutbound(id, 'sending', result.outcome, {result});
    return summary(this.store.outbound(id));
  }
}
