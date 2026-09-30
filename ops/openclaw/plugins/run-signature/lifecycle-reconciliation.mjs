import {createHash} from 'node:crypto';

// Offline inspection only. This module never selects a live authority, writes
// state, infers a generation from a fence revision, or publishes old reports.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => Number.isFinite(value) && value >= 0;
export function canonicalLifecycleKey(value) {
  const match = String(value ?? '').match(/^(?:agent:[a-z][a-z0-9-]*:slack:channel:|slack:)([CDG][A-Z0-9]+):(?:thread:)?(\d{10}\.\d{6})$/i);
  return match ? `slack:${match[1].toUpperCase()}:${match[2]}` : undefined;
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  return object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
}
export const lifecycleDigest = value => createHash('sha256').update(JSON.stringify(stable(value)) ?? 'undefined').digest('hex');

export function reconcileLifecycleHistory({fences, journal, owners = [], events = []}) {
  const issues = [], records = new Map();
  const counts = {fences: 0, journalConversations: 0, turns: 0, closes: 0, ownerClaims: 0, events: 0, duplicateEvents: 0};
  const issue = (code, source, conversation = null) => issues.push({code, source, conversation});
  const get = (raw, source) => {
    const key = canonicalLifecycleKey(raw);
    if (!key) { issue('invalid_conversation', source); return; }
    if (!records.has(key)) records.set(key, {conversation: key, sources: [], closedEvents: [], closeTurns: []});
    const record = records.get(key);
    record.sources.push(source);
    return record;
  };
  if (!object(fences) || fences.schemaVersion !== 1 || !object(fences.conversations)) {
    issue('invalid_fence_snapshot', 'fences');
  } else for (const [raw, fence] of Object.entries(fences.conversations)) {
    counts.fences++;
    const source = `fences:${raw}`, record = get(raw, source);
    if (!record) continue;
    if (!object(fence)) { issue('invalid_fence', source, record.conversation); continue; }
    if (record.legacyFence) {
      // Canonicalization must not silently choose between aliases, even when equal.
      issue('duplicate_fence_mapping', source, record.conversation);
      continue;
    }
    record.legacyFence = structuredClone(fence);
    const validState = ['open', 'closing', 'closed'].includes(fence.state);
    if (!validState || !Number.isSafeInteger(fence.revision) || fence.revision < 1 ||
        !timestamp(fence.openedAt) || !timestamp(fence.updatedAt) || fence.updatedAt < fence.openedAt)
      issue('invalid_fence', source, record.conversation);
    if (fence.state === 'closing') issue('unresolved_close', source, record.conversation);
    if (fence.closedThrough !== undefined && !timestamp(fence.closedThrough))
      issue('invalid_boundary', source, record.conversation);
    if (fence.state === 'closed' && (!timestamp(fence.closedThrough) || !timestamp(fence.closedAt) ||
        fence.closedThrough < fence.closedAt || !/^\d{10}\.\d{6}$/.test(String(fence.closeMessageId ?? ''))))
      issue('incomplete_closed_boundary', source, record.conversation);
    if (fence.closedThrough !== undefined && fence.closedThrough > fence.updatedAt)
      issue('boundary_after_update', source, record.conversation);
    if (fence.state === 'open' && fence.closedThrough !== undefined &&
        (!timestamp(fence.reopenedAt) || fence.reopenedAt < fence.closedThrough || !fence.reopenedByMessageId))
      issue('unproven_reopen', source, record.conversation);
    if (timestamp(fence.closedThrough)) {
      record.boundary = {id: `legacy-boundary:${lifecycleDigest([record.conversation, fence.closedThrough, fence.closeMessageId ?? null])}`,
        closedThrough: fence.closedThrough, closeMessageId: fence.closeMessageId ?? null,
        generation: null};
    }
  }
  if (!object(journal) || !object(journal.conversations) || !object(journal.turns) ||
      (journal.lifecycleSchemaVersion !== undefined && journal.lifecycleSchemaVersion !== 1)) {
    issue('invalid_journal', 'journal');
  } else {
    for (const [raw, conversation] of Object.entries(journal.conversations)) {
      counts.journalConversations++;
      const source = `journal.conversations:${raw}`, record = get(raw, source);
      if (!record) continue;
      if (!object(conversation)) { issue('invalid_journal_conversation', source, record.conversation); continue; }
      if (record.journal) { issue('duplicate_journal_mapping', source, record.conversation); continue; }
      record.journal = structuredClone(conversation);
      if (raw !== record.conversation) issue('noncanonical_journal_key', source, record.conversation);
      if (conversation.generation !== undefined && (!Number.isSafeInteger(conversation.generation) || conversation.generation < 0 ||
          !['open', 'closing', 'closed'].includes(conversation.state))) issue('invalid_generation', source, record.conversation);
      if (conversation.reconciliationRequired) issue('reconciliation_required', source, record.conversation);
      if (conversation.state === 'closing') issue('unresolved_close', source, record.conversation);
      if (conversation.closedThrough !== undefined && !timestamp(conversation.closedThrough)) issue('invalid_boundary', source, record.conversation);
      if (conversation.generation === undefined && (conversation.state !== undefined || conversation.closedThrough !== undefined))
        issue('unversioned_boundary', source, record.conversation);
      if (conversation.status !== undefined && !['act', 'scheduled', 'closed'].includes(conversation.status))
        issue('invalid_journal_status', source, record.conversation);
    }
    for (const [key, turn] of Object.entries(journal.turns)) {
      counts.turns++;
      const source = `journal.turns:${key}`;
      if (!object(turn)) { issue('invalid_turn', source); continue; }
      const record = get(turn.conversation, source);
      if (!record) continue;
      if (!record.journal) issue('orphan_turn', source, record.conversation);
      if (key !== turn.key || !timestamp(turn.startedAt) || !['running', 'reserved', 'queued', 'delivered', 'sent', 'failed', 'intentional_non_delivery'].includes(turn.phase))
        issue('invalid_turn', source, record.conversation);
      if (turn.generation !== undefined && (!Number.isSafeInteger(turn.generation) || turn.generation < 0 || turn.generation > (record.journal?.generation ?? 0)))
        issue('invalid_turn_generation', source, record.conversation);
      if (turn.route && canonicalLifecycleKey(`slack:${turn.route.channel}:${turn.route.threadId}`) !== record.conversation)
        issue('turn_route_mismatch', source, record.conversation);
      if (turn.envelope?.status === 'closed') {
        record.closeTurns.push({key, phase: turn.phase, messageId: turn.messageId ?? null, startedAt: turn.startedAt});
        if (!['sent', 'failed', 'intentional_non_delivery'].includes(turn.phase)) issue('pending_historical_close', source, record.conversation);
      }
    }
  }
  if (journal?.closes !== undefined && !object(journal.closes)) issue('invalid_closes', 'journal.closes');
  else for (const [key, close] of Object.entries(journal?.closes ?? {})) {
    counts.closes++;
    const source = `journal.closes:${key}`, record = get(close?.conversation, source);
    if (!record) continue;
    if (!object(close) || close.key !== key || key !== `${record.conversation}:close:${close.generation}` ||
        !Number.isSafeInteger(close.generation) || close.generation < 0 || !record.journal ||
        close.generation > record.journal.generation || !timestamp(close.startedAt) ||
        canonicalLifecycleKey(`slack:${close.route?.channel}:${close.route?.threadId}`) !== record.conversation)
      issue('invalid_close_mapping', source, record.conversation);
    if (close.phase !== 'complete') issue('active_host_close', source, record.conversation);
    if (!close.messageId || typeof close.snapshot?.report !== 'string') issue('incomplete_host_close', source, record.conversation);
  }
  if (!Array.isArray(owners)) issue('invalid_owner_claims', 'owners');
  else for (const [index, claim] of owners.entries()) {
    counts.ownerClaims++;
    const source = `owners:${index + 1}`;
    const record = get(claim?.key, source);
    if (!record) continue;
    if (!/^[a-z][a-z0-9-]*$/.test(claim.owner ?? '')) { issue('invalid_sender', source, record.conversation); continue; }
    // Routing order is the append order, not timestamp sorting or first mention.
    record.sender = claim.owner;
  }
  const seen = new Map();
  if (!Array.isArray(events)) issue('invalid_events', 'events');
  else for (const [index, event] of events.entries()) {
    if (!['session.completed', 'status.set'].includes(event?.kind)) continue;
    counts.events++;
    const source = `events:${index + 1}`;
    if (typeof event.id !== 'string' || !event.id) { issue('missing_event_id', source); continue; }
    const digest = lifecycleDigest(event);
    if (seen.has(event.id)) {
      if (seen.get(event.id) === digest) counts.duplicateEvents++;
      else issue('conflicting_event_id', source, canonicalLifecycleKey(event.logicalSessionId) ?? null);
      continue;
    }
    seen.set(event.id, digest);
    const record = get(event.logicalSessionId, source);
    if (!record) continue;
    if (event.kind === 'session.completed') {
      const messageId = event.details?.closeMessageId ?? null;
      record.closedEvents.push({id: event.id, messageId});
      if (!/^\d{10}\.\d{6}$/.test(String(messageId ?? '')))
        issue('unmapped_completion', source, record.conversation);
    }
  }
  for (const record of records.values()) {
    const fence = record.legacyFence, current = record.journal;
    const modern = current?.generation !== undefined;
    const close = journal?.closes?.[current?.closeOperation];
    if (modern) {
      if (current.legacyBoundary && !fence) issue('missing_legacy_source', 'fences+journal', record.conversation);
      if (close && (!timestamp(current.closedThrough) || current.closedThrough < close.startedAt ||
          (current.state === 'closed' && current.generation !== close.generation)))
        issue('lost_host_boundary', 'journal', record.conversation);
      if (current.closeOperation && (!close || close.conversation !== record.conversation))
        issue('missing_close_operation', 'journal', record.conversation);
      if (fence && lifecycleDigest(current.legacyBoundary) !== lifecycleDigest(fence))
        issue('legacy_provenance_mismatch', 'fences+journal', record.conversation);
      if (timestamp(fence?.closedThrough) && (!timestamp(current.closedThrough) || current.closedThrough < fence.closedThrough))
        issue('lost_historical_boundary', 'fences+journal', record.conversation);
      if ((current.state === 'closed' || current.closedThrough !== undefined) && !fence && !close && !current.legacyBoundary)
        issue('orphan_closure', 'journal', record.conversation);
      if (current.state === 'closed' && !timestamp(current.closedThrough)) issue('invalid_boundary', 'journal', record.conversation);
    } else if (fence && current?.status !== undefined &&
        ((fence.state === 'closed') !== (current.status === 'closed')))
      issue('state_disagreement', 'fences+journal', record.conversation);
    if (!fence && !modern && (current?.status === 'closed' || record.closedEvents.length || record.closeTurns.some(turn => turn.phase === 'sent')))
      issue('orphan_closure', 'journal+events', record.conversation);
    if (!timestamp(fence?.closedThrough) && !timestamp(current?.closedThrough) && !close &&
        (record.closedEvents.length || record.closeTurns.some(turn => turn.phase === 'sent')))
      issue('missing_historical_boundary', 'fences+history', record.conversation);
  }
  return {schemaVersion: 1, mode: 'read-only', applySupported: false, authority: 'final-decisions.json',
    sourceDigest: lifecycleDigest({fences, journal, owners, events}), counts,
    consistent: issues.length === 0, issues,
    conversations: [...records.values()].sort((a, b) => a.conversation.localeCompare(b.conversation))};
}
