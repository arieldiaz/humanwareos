import {EmailIntakeService, normalizeMessage, digest} from './framework.mjs';
import {authenticateMail} from './authenticate.mjs';
import {render} from './render.mjs';

export function normalizeEvent(event, config = {}) {
  // Mail from any of our own routed domains is a loop, never a new request.
  const ownDomains = new Set(Object.keys(config.routes ?? {}).map(a => a.split('@')[1]?.toLowerCase()).filter(Boolean));
  const auto = String(event.autoSubmitted ?? '').toLowerCase();
  const precedence = String(event.precedence ?? '').toLowerCase();
  const sender = event.sender ?? event.envelopeFrom;
  return normalizeMessage({source: 'cloudflare-email-routing', deliveryId: event.deliveryId ?? event.eventId,
    recipient: event.recipient, sender, messageId: event.messageId || null, inReplyTo: event.inReplyTo || null,
    references: event.references ?? [], subject: event.subject ?? '', receivedAt: event.receivedAt,
    sizeBytes: event.sizeBytes ?? event.rawSize,
    automatic: ownDomains.has(String(sender).toLowerCase().split('@').at(-1)) ? 'loop' : ['bulk', 'junk', 'list'].includes(precedence) ? 'bulk' : auto && auto !== 'no' ? 'automated' : 'none',
    evidenceRef: `sqlite:${config.tablePrefix ?? 'email_intake'}_evidence:${digest([event.recipient, event.messageId || event.deliveryId || event.eventId])}`});
}

export class Intake {
  constructor({store, config, channel, slack, calendar, sessions = null, authenticate = authenticateMail, log = (event) => console.log(JSON.stringify(event))}) {
    Object.assign(this, {store, config, channel, slack, calendar, sessions, authenticate, log});
    this.serial = Promise.resolve(); this.ready = false;
    this.service = new EmailIntakeService({repository: store.repository, ...config, intakeChannelId: channel.channelId,
      authenticateOwner: (message) => {
        const proof = store.evidence(message.key)?.value?.authentication;
        return proof ? {...proof, messageKey: message.key} : null;
      },
      verifiedReceipt: (message) => {
        const receipt = store.evidence(message.key)?.domain?.receipt;
        return receipt ? {...receipt, messageKey: message.key} : null;
      }});
  }
  exclusive(task) { const next = this.serial.then(task); this.serial = next.catch(() => {}); return next; }
  async verify() { await this.slack.verify(); await this.sessions?.verify?.(); this.ready = true; }
  receive(event) { return this.exclusive(async () => {
    let message;
    try { message = normalizeEvent(event, this.config); } catch { throw Object.assign(new Error('invalid_event'), {status: 400}); }
    if (!Object.hasOwn(this.config.routes, message.recipient)) throw Object.assign(new Error('undeclared_recipient'), {status: 422});
    if (message.sizeBytes > this.config.maxBytes) throw Object.assign(new Error('oversized'), {status: 413});
    if (typeof event.textBody !== 'undefined' && (typeof event.textBody !== 'string' || event.textBody.length > 32768)) throw Object.assign(new Error('invalid_text'), {status: 400});
    if (event.calendarPayload != null && (typeof event.calendarPayload !== 'string' || event.calendarPayload.length > 65536)) throw Object.assign(new Error('invalid_calendar'), {status: 400});
    const verified = await this.authenticate(event, this.config);
    event = verified.event;
    message = normalizeEvent(event, this.config);
    // First immutable evidence wins across redelivery, including altered bodies.
    const evidence = this.store.evidence(message.key, {message, textBody: event.textBody ?? '', calendarPayload: event.calendarPayload ?? null, authentication: verified.authentication, attachments: verified.attachments, htmlOnly: event.htmlOnly ?? false, rawBase64: event.rawBase64 ?? null});
    message = evidence.value.message;
    if (!evidence.domain) {
      const domain = (this.config.calendarRecipients ?? []).includes(message.recipient) ? await this.calendar({recipient: message.recipient, messageId: message.messageId ?? message.deliveryId,
        eventId: message.deliveryId, receivedAt: message.receivedAt, subject: message.subject, replyTo: message.sender,
        textBody: evidence.value.textBody, calendarPayload: evidence.value.calendarPayload}) : {ok: true, status: 'context_only'};
      this.store.domain(message.key, domain);
    }
    const result = this.service.receive(message);
    const domain = this.store.evidence(message.key).domain;
    if (domain.status === 'rejected') {
      this.store.repository.atomic(`calendar-failure:${message.key}`, message.key, () => {
        this.store.repository.enqueue({key: `calendar-failure:${message.key}`, intakeId: result.value.intakeId, kind: 'intake_append', payload: {messageKey: message.key, failure: true}});
        return {ok: true};
      });
    }
    await this.drain();
    const pending = this.store.repository.pendingEffects().some((e) => e.intakeId === result.value.intakeId);
    if (pending) throw new Error('delivery_pending');
    return {ok: true, replay: result.replay, state: result.value.state};
  }); }
  async drain() {
    if (!this.ready) await this.verify();
    const repository = this.store.repository;
    const blocked = new Set();
    for (const effect of repository.pendingEffects()) {
      if (blocked.has(effect.intakeId)) continue;
      let conversation = repository.read(effect.intakeId);
      try {
        // Retired pending domain-status effects must never write conversation state.
        if (effect.kind === 'intake_status') { repository.acknowledgeEffect(effect.key, {retired: true}); continue; }
        if (!['intake_root', 'intake_append', 'owner_dispatch'].includes(effect.kind)) throw new Error('unsupported_effect');
        if (effect.kind !== 'intake_root' && !conversation.intakeThread) continue;
        if (effect.kind === 'owner_dispatch') {
          if (!this.sessions) throw new Error('session_adapter_unavailable');
          const result = await this.sessions.dispatch(effect, conversation, this.store.evidence(effect.payload.messageKey).value);
          repository.acknowledgeEffect(effect.key, result);
          this.store.clearFault(effect.key);
          continue;
        }
        {
          let delivery = this.store.delivery(effect.key);
          let confirmed = delivery?.result;
          if (!confirmed && delivery) {
            confirmed = await this.slack.find(effect, conversation, delivery.started_at);
            // Never blindly repeat an uncertain publication, even after restart.
            if (!confirmed) throw new Error('ambiguous_slack_delivery');
          }
          if (!confirmed) {
            const {message} = repository.message(effect.payload.messageKey);
            const evidence = this.store.evidence(message.key);
            const text = effect.payload.failure ? 'The calendar invitation could not be recorded. Review is required in Slack; the diagnostic is retained privately.' : render(message, evidence, this.config.labels[message.recipient], effect.payload.receipt);
            this.store.start(effect.key);
            confirmed = await this.slack.send(effect, conversation, text);
          }
          this.store.confirmed(effect.key, confirmed);
          if (effect.kind === 'intake_root') {
            this.service.linkIntakeThread(effect.intakeId, effect.key, confirmed);
            conversation = repository.read(effect.intakeId);
          }
        }
        repository.acknowledgeEffect(effect.key, {delivered: true});
        this.store.clearFault(effect.key);
      } catch (error) {
        blocked.add(effect.intakeId);
        const code = ['ambiguous_slack_delivery', 'ambiguous_session_admission'].includes(error.message) ? error.message : 'intake_delivery_failed';
        if (this.store.fault(effect.key, code)) this.log({event: 'email_intake_fault', key: digest(effect.key), code});
        // Other conversations can progress; this conversation waits for its root.
      }
    }
  }
  deadLetter(event) { return this.exclusive(async () => {
    const message = normalizeEvent(event, this.config);
    if (!Object.hasOwn(this.config.routes, message.recipient)) throw Object.assign(new Error('undeclared_recipient'), {status: 422});
    if (this.store.fault(`dlq:${message.key}`, 'queue_exhausted')) this.log({event: 'email_intake_fault', key: message.key, code: 'queue_exhausted'});
    return {ok: true};
  }); }
  health() { const store = this.store.health(); return {ok: this.ready && store.sqlite && store.faults === 0, service: 'email-intake', ready: this.ready, ...store}; }
}

export function calendarClient({url, secret, fetcher = fetch}) {
  return async (payload) => {
    const response = await fetcher(url, {method: 'POST', headers: {'content-type': 'application/json', 'x-calendar-ingest-secret': secret}, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000)});
    if (response.status === 400 && payload.calendarPayload) return {status: 'rejected'};
    if (!response.ok) throw new Error('calendar_unavailable');
    const result = await response.json();
    if (!result.ok || (payload.calendarPayload && (!result.receipt?.verified || result.receipt.resourceId !== result.eventId))) throw new Error('calendar_receipt_missing');
    return result;
  };
}
