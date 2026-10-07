/* Shared metadata trace, used by Activity and by the session view/instance overlay. */
import {escapeHtml} from '../ui.js';
export {escapeHtml};
export const sessionLink = (session, run = null) => `/sessions/?${new URLSearchParams({session, ...(run ? {run} : {})})}`;
export function freshness(data, now = Date.now()) {
  const time = Date.parse(data?.generatedAt);
  return !Number.isFinite(time) ? 'Unavailable' : now - time > 120000 ? 'Stale' : 'Current';
}
export function matches(row, filters = {}) {
  return Object.entries(filters).every(([key, value]) => {
    if (!value) return true;
    const actual = {identity: row.actor?.identity, target: row.target?.id, session: row.logicalSessionId,
      run: row.runId, from: row.ts?.slice(0, 10), to: row.ts?.slice(0, 10)}[key] ?? row[key];
    if (key === 'from') return actual >= value;
    if (key === 'to') return actual <= value;
    return String(actual ?? '').toLowerCase().includes(value.toLowerCase());
  });
}
const refText = ref => ref ? `${ref.type}: ${ref.id}${ref.localOnly ? ' (local only)' : ''}` : 'Unavailable';
export function traceHtml(row) {
  const esc = escapeHtml;
  const authority = row.authority || {result: 'unknown'};
  const policy = row.policy || {result: 'unknown'};
  const memory = row.memory;
  const fields = [
    ['Actor / profile', `${row.actor?.identity || row.agent || 'unknown'} / ${row.actor?.profileId || 'unknown'}`],
    ['Authority', `${authority.result} · ${refText(authority.ref)}`],
    ['Policy', `${policy.result} · ${policy.id || 'unknown'} @ ${policy.version || 'unknown'}`],
    ['Target / outcome', `${row.target?.id || 'Unavailable'} · ${row.outcome || 'unknown'}`],
    ['Reason / entered context', `${row.reasonCode || 'unavailable'} · ${row.enteredContext == null ? 'unavailable' : row.enteredContext ? 'yes' : 'no'}`],
    ['Source', refText(row.sourceRef)],
    ['Selected sources', (row.sourceRefs || []).map(refText).join('\n') || 'Unavailable'],
    ...(memory ? [['Claim / introduced by', `${memory.claimId} / ${memory.introducedBy || 'unavailable'}`],
      ['Scope / projections', `${memory.visibility} / ${memory.projections.join(', ') || 'none'}`],
      ['Supersedes', memory.supersedes.join(', ') || 'none']] : []),
    ...(row.cost ? [['Cost', row.cost.status === 'unavailable' ? 'Unavailable' : `${row.cost.amount} ${row.cost.currency} · ${row.cost.status}`],
      ['Usage identity', row.cost.usageId], ['Tokens', JSON.stringify(row.cost.tokens)], ['Cost evidence', refText(row.cost.basisRef)]] : []),
  ];
  return `<dl>${fields.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>
    <p>Parents: ${(row.parentIds || []).map(id => `<a href="/activity/?event=${encodeURIComponent(id)}#event-${encodeURIComponent(id)}">${esc(id)}</a>`).join(', ') || 'Unavailable'}</p>
    <p class="muted">Raw references resolve only in an authorized local evidence reader.</p>`;
}
export function renderTrace(container, rows) {
  container.innerHTML = rows.map(row => `<details id="event-${encodeURIComponent(row.id)}" class="event ${['outward','irreversible'].includes(row.reversibility) ? 'consequential' : ''}">
    <summary><time>${escapeHtml(row.ts)}</time> <strong>${escapeHtml(row.kind)}</strong> · ${escapeHtml(row.actor?.identity || row.agent)} · ${escapeHtml(row.outcome || 'unknown')} <span>${escapeHtml(row.reversibility || '')}</span></summary>
    <p><a href="${escapeHtml(sessionLink(row.logicalSessionId || '', row.runId))}">Open session and run</a> · ${escapeHtml(row.id)}</p>${traceHtml(row)}</details>`).join('') || '<p>No observed events match.</p>';
  if (location.hash.startsWith('#event-')) {
    const target = document.getElementById(location.hash.slice(1));
    if (target) { target.open = true; target.scrollIntoView(); }
  }
}
