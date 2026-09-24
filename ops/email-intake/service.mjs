import {ownerAuthority} from "./owner-session.mjs";
import {randomUUID} from "node:crypto";
import {address, classify, digest, handlingTransition, instant, normalizeMessage, normalizeReceipt, required} from "./model.mjs";
import {assertIntakeRepository} from "./repository.mjs";

function sync(value) {
  if (value?.then) throw new Error("intake ports must be synchronous");
  return value;
}

/** References (nearest ancestor first), then parent, then unique bounded subject. */
export function correlate(repository, message, windowMs) {
  for (const id of [...message.references].reverse().concat(message.inReplyTo ? [message.inReplyTo] : [])) {
    const found = repository.byMessageId(message.recipient, id);
    if (found) return found;
  }
  // Unknown explicit ancestry must not accidentally join an unrelated subject.
  if (message.references.length || message.inReplyTo) return null;
  const candidates = repository.bySubject(message, windowMs);
  return candidates.length === 1 ? candidates[0] : null;
}

export class EmailIntakeService {
  constructor({repository, routes, intakeChannelId, maxBytes, subjectWindowMs,
    authenticateOwner = () => null, assessQuick = () => null, verifiedReceipt = () => null,
    authenticateSlack = () => null, resolveDestination = () => null,
    now = () => new Date().toISOString(), newId = randomUUID}) {
    this.repository = assertIntakeRepository(repository);
    this.routes = new Map(Object.entries(routes).map(([recipient, owner]) => [address(recipient), required(owner, "owner")]));
    this.intakeChannelId = required(intakeChannelId, "intake channel");
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be positive");
    if (!Number.isSafeInteger(subjectWindowMs) || subjectWindowMs <= 0) throw new Error("subjectWindowMs must be positive");
    Object.assign(this, {maxBytes, subjectWindowMs, authenticateOwner, assessQuick, verifiedReceipt, authenticateSlack, resolveDestination, now, newId});
  }

  receive(input) {
    const message = normalizeMessage(input);
    const owner = this.routes.get(message.recipient);
    // Rejected ingress creates no conversation, Slack effect, or agent dispatch.
    if (!owner || message.sizeBytes > this.maxBytes) return {value: {state: "rejected", reason: owner ? "oversized" : "undeclared_recipient"}, replay: false};
    const repository = this.repository;
    // Transport redelivery may carry a new provider delivery ID or receive timestamp.
    // The first accepted immutable message wins by recipient + Message-ID.
    return repository.atomic(`email:${message.key}`, message.key, () => {
      const receipt = normalizeReceipt(sync(this.verifiedReceipt(message)), message.key);
      const authority = !receipt && message.automatic === "none" ? ownerAuthority(sync(this.authenticateOwner(message)), message) : null;
      const receiptKey = receipt ? digest([message.recipient, receipt.domain, receipt.operationId]) : null;
      const priorReceipt = receiptKey ? repository.receipt(receiptKey) : null;
      if (priorReceipt && priorReceipt.receipt.resourceId !== receipt.resourceId) throw new Error("domain receipt identity conflict");
      const correlated = priorReceipt ? repository.read(priorReceipt.intakeId) : correlate(repository, message, this.subjectWindowMs);
      const current = correlated && (correlated.authority?.principal ?? null) === (authority?.principal ?? null) ? correlated : null;
      const time = instant(this.now());
      const classification = authority ? {intakeClass: "owner_session", state: "working", lifecycle: "working"} : classify({receipt, assessment: receipt || message.automatic !== "none" ? null : sync(this.assessQuick(message)), automatic: message.automatic});
      // Only independently authenticated owner follow-ups can enqueue another turn.
      const conversation = current ? {...current, revision: current.revision + 1, updatedAt: time,
        lastReceivedAt: message.receivedAt > current.lastReceivedAt ? message.receivedAt : current.lastReceivedAt,
      } : {
        schemaVersion: 1, intakeId: required(this.newId(), "intake ID"), revision: 1,
        recipient: message.recipient, sender: message.sender, subjectKey: message.subjectKey,
        owner, ...classification, createdAt: time, updatedAt: time, lastReceivedAt: message.receivedAt,
        intakeThread: null, authority, promotion: null, wake: null, receipt, failure: null,
      };
      repository.save(conversation, current?.revision ?? 0);
      repository.addMessage(message, conversation.intakeId);
      if (receiptKey && !priorReceipt) repository.addReceipt(receiptKey, conversation.intakeId, receipt);
      if (!priorReceipt) {
        repository.enqueue({key: current ? `mail:${message.key}` : `root:${conversation.intakeId}`, intakeId: conversation.intakeId,
          kind: current ? "intake_append" : "intake_root", payload: {messageKey: message.key, receipt, classification}});
      }
      if (!current && classification.intakeClass === "quick") {
        repository.enqueue({key: `quick:${message.key}`, intakeId: conversation.intakeId, kind: "quick_dispatch", payload: {messageKey: message.key, owner, scope: "bounded_quick", allowEmailReply: message.automatic === "none"}});
      }
      if (authority) repository.enqueue({key: `owner:${message.key}`, intakeId: conversation.intakeId, kind: "owner_dispatch", payload: {messageKey: message.key, principal: authority.principal}});
      return conversation;
    });
  }

  #change(intakeId, operationId, input, apply) {
    required(operationId, "operation ID");
    return this.repository.atomic(operationId, digest([intakeId, input]), () => {
      const current = this.repository.read(intakeId);
      if (!current) throw new Error("unknown intake");
      const next = {...apply(current), revision: current.revision + 1, updatedAt: instant(this.now())};
      this.repository.save(next, current.revision);
      if (next.lifecycle !== current.lifecycle) {
        this.repository.enqueue({key: `status:${operationId}`, intakeId, kind: "intake_status", payload: {lifecycle: next.lifecycle}});
      }
      return next;
    });
  }

  // Trusted delivery adapter records the confirmed original root, never a work root.
  linkIntakeThread(intakeId, operationId, thread) {
    required(operationId, "operation ID");
    const normalized = {channelId: required(thread.channelId, "channel"), threadTs: required(thread.threadTs, "thread timestamp")};
    if (normalized.channelId !== this.intakeChannelId) throw new Error("incorrect intake channel");
    return this.#change(intakeId, `link:${operationId}`, normalized, (current) => {
      if (current.intakeThread && JSON.stringify(current.intakeThread) !== JSON.stringify(normalized)) throw new Error("intake root is immutable");
      return {...current, intakeThread: normalized};
    });
  }

  // Trusted agent/control-plane boundary; not an email event dispatcher.
  handle(intakeId, operationId, event) {
    required(operationId, "operation ID");
    return this.#change(intakeId, `handling:${operationId}`, event, (current) => {
      if (event.kind === "scheduled" && Date.parse(instant(event.wake?.at)) <= Date.parse(instant(this.now()))) throw new Error("durable wake must be in the future");
      return handlingTransition(current, event);
    });
  }

  #slack(intakeId, authentication) {
    // This port authenticates the transport and allowed human actor, and returns
    // the original Slack event. Neither command text nor identity comes from email.
    const event = sync(this.authenticateSlack(authentication));
    if (!event || event.surface !== "slack" || event.trustedHuman !== true) throw new Error("trusted human Slack event required");
    const normalized = Object.fromEntries(["workspaceId", "eventId", "actorId", "channelId", "threadTs", "text"].map((key) => [key, required(event[key], key)]));
    const current = this.repository.read(intakeId);
    if (!current?.intakeThread || current.intakeThread.channelId !== normalized.channelId || current.intakeThread.threadTs !== normalized.threadTs) throw new Error("Slack command must belong to the intake thread");
    return normalized;
  }

  promote(intakeId, authentication) {
    const event = this.#slack(intakeId, authentication);
    const match = /^(start a coding session in|promote to) (#[a-z0-9][a-z0-9_-]*)$/i.exec(event.text);
    const operationId = `promotion:${digest([event.workspaceId, event.eventId])}`;
    return this.#change(intakeId, operationId, event, (current) => {
      if (current.promotion) return current; // One durable work intent per conversation.
      if (!["awaiting_promotion", "working", "answered", "clarify", "act", "scheduled"].includes(current.state)) throw new Error("intake cannot be promoted from this state");
      const name = match?.[2].toLowerCase();
      const destination = name ? sync(this.resolveDestination(name)) : null;
      if (!destination?.channelId || destination.name !== name || destination.channelId === this.intakeChannelId) {
        this.repository.enqueue({key: `question:${operationId}`, intakeId, kind: "promotion_question", payload: {reason: "named_resolvable_destination_required"}});
        return {...current, state: "awaiting_promotion", lifecycle: "act", wake: null};
      }
      const promotion = {operationId, actorId: event.actorId, slackEventId: event.eventId,
        destination: {name, channelId: required(destination.channelId, "destination channel")},
        codingSession: match[1].toLowerCase().startsWith("start"), workThread: null, sessionId: null};
      this.repository.enqueue({key: `work:${intakeId}`, intakeId, kind: "promoted_work", payload: promotion});
      return {...current, state: "promoted", lifecycle: "act", wake: null, promotion};
    });
  }

  close(intakeId, authentication) {
    const event = this.#slack(intakeId, authentication);
    if (event.text.toLowerCase() !== "close intake") throw new Error("explicit close intake command required");
    return this.#change(intakeId, `close:${digest([event.workspaceId, event.eventId])}`, event,
      (current) => ({...current, state: "closed", lifecycle: "done", wake: null}));
  }

  fail(intakeId, operationId, {code, exhausted = false}) {
    required(operationId, "operation ID");
    required(code, "diagnostic code", 120);
    if (!/^[a-z0-9_]+$/.test(code) || typeof exhausted !== "boolean") throw new Error("failure requires a safe code and boolean exhausted");
    return this.#change(intakeId, `failure:${operationId}`, {code, exhausted}, (current) => {
      if (current.state === "dead_letter") return current;
      const failure = {code, attempts: (current.failure?.attempts ?? 0) + 1,
        resumeState: current.failure?.resumeState ?? current.state, resumeLifecycle: current.failure?.resumeLifecycle ?? current.lifecycle};
      if (exhausted) this.repository.enqueue({key: `fault:${intakeId}`, intakeId, kind: "operational_fault", payload: {code}});
      return {...current, state: exhausted ? "dead_letter" : "retrying", lifecycle: null, failure};
    });
  }

  retry(intakeId, operationId) {
    required(operationId, "operation ID");
    return this.#change(intakeId, `retry:${operationId}`, {}, (current) => {
      if (current.state !== "retrying") throw new Error("intake is not retrying");
      return {...current, state: current.failure.resumeState, lifecycle: current.failure.resumeLifecycle, failure: null};
    });
  }
}
