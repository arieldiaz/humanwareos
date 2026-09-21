import {normalizeEvent, reviseEvent} from "./model.js";
import {authorizeMutation} from "./policy.js";

const STORE_METHODS = ["list", "read", "readByUid", "claimOperation", "commit", "tombstone"];

export function assertCalendarStore(store) {
  for (const method of STORE_METHODS) if (typeof store?.[method] !== "function") throw new Error(`calendar store must implement ${method}()`);
  return store;
}

export class CalendarService {
  constructor({store, trustedInvitationRecipients = [], now = () => new Date().toISOString()}) {
    this.store = assertCalendarStore(store);
    this.trustedInvitationRecipients = trustedInvitationRecipients;
    this.now = now;
  }
  list(query) { return this.store.list(query); }
  read(id) { return this.store.read(id); }
  async mutate(action, input, policy) {
    const authorized = authorizeMutation(policy, {allowInbound: true, trustedRecipients: this.trustedInvitationRecipients});
    const replay = await this.store.claimOperation(authorized.operationId);
    if (replay) return {...replay, idempotentReplay: true};
    const timestamp = this.now();
    let current = input.id ? await this.store.read(input.id, {includeDeleted: true}) : null;
    if (!current && input.uid) current = await this.store.readByUid(input.calendarId ?? input.event?.calendarId, input.uid, input.recurrenceId);
    if (input.expectedRevision !== undefined && current?.revision !== input.expectedRevision) throw new Error("event revision conflict");
    let event;
    if (action === "create") {
      if (current) throw new Error("event UID already exists");
      event = normalizeEvent(input.event, {now: timestamp});
    } else {
      if (!current) throw new Error("event not found");
      if (action === "delete") return this.store.tombstone(current, {policy: authorized, now: timestamp});
      event = reviseEvent(current, action === "cancel" ? {...(input.event ?? {}), status: "cancelled"} : input.event, timestamp);
    }
    return this.store.commit(event, {action, policy: authorized, now: timestamp});
  }
  create(input) { return this.mutate("create", input, input.policy); }
  update(input) { return this.mutate("update", input, input.policy); }
  cancel(input) { return this.mutate("cancel", input, input.policy); }
  delete(input) { return this.mutate("delete", input, input.policy); }
  async applyInvitation(calendarId, proposal) {
    authorizeMutation(proposal.policy, {allowInbound: true, trustedRecipients: this.trustedInvitationRecipients});
    const current = await this.store.readByUid(calendarId, proposal.event.uid, proposal.event.recurrenceId);
    const priorSequence = current?.provenance?.sourceRevision ?? -1;
    if (proposal.sourceRevision < priorSequence) throw new Error("invitation sequence is stale");
    if (current && proposal.sourceRevision === priorSequence) return {...current, idempotentReplay: true};
    if (proposal.action === "cancel") {
      if (!current) throw new Error("cannot cancel an invitation that was not imported");
      return this.cancel({id: current.id, expectedRevision: current.revision, event: {provenance: proposal.event.provenance}, policy: proposal.policy});
    }
    const event = {...proposal.event, calendarId};
    if (current) return this.update({id: current.id, expectedRevision: current.revision, event, policy: proposal.policy});
    return this.create({event, policy: proposal.policy});
  }
}
