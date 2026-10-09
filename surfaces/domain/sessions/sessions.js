import {escapeHtml as esc, freshness, renderTrace} from '../activity/trace.js';
const $ = id => document.getElementById(id);
const FILTERS = [['open','Open'],['all','All'],['active','Active'],['needs_you','Needs you'],['error','Errors'],['completed','Completed'],['idle','Idle']];
const LEVELS = [['normal','Normal'],['verbose','Verbose'],['forensic','Forensic']];
const allowed = {normal: new Set(['normal']), verbose: new Set(['normal','verbose']), forensic: new Set(['normal','verbose','forensic'])};
const statusLabel = s => ({active:'Active', needs_you:'Needs you', error:'Error', completed:'Completed', idle:'Idle'}[s] || s);
const age = iso => { if (!iso) return '—'; const sec = Math.max(0, (Date.now() - new Date(iso)) / 1000); return sec < 60 ? `${Math.floor(sec)}s` : sec < 3600 ? `${Math.floor(sec / 60)}m` : sec < 86400 ? `${Math.floor(sec / 3600)}h` : `${Math.floor(sec / 86400)}d`; };
const fmtNum = n => new Intl.NumberFormat('en-US', {notation: n > 999 ? 'compact' : 'standard'}).format(n || 0);
// Activity links to /sessions/?session=&run=; older links used #<session id>.
const params = new URLSearchParams(location.search);
let DATA = {sessions: [], summary: {}}, filter = 'open', level = 'normal', run = params.get('run') || '';
let selected = params.get('session') || (location.hash && !location.hash.startsWith('#event-') ? decodeURIComponent(location.hash.slice(1)) : null);
const session = () => (DATA.sessions || []).find(s => s.id === selected);
function syncUrl() {
  const query = selected ? `?${new URLSearchParams({session: selected, ...(run && run !== 'unknown' ? {run} : {})})}` : '';
  history.replaceState(null, '', location.pathname + query);
}
function renderFilters() {
  $('statusFilters').innerHTML = FILTERS.map(([k, v]) => `<button class="${filter === k ? 'active' : ''}" data-filter="${k}">${v}</button>`).join('');
  document.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => { filter = b.dataset.filter; render(); });
}
function renderSummary() {
  const s = DATA.summary || {};
  $('summary').innerHTML = [['Active', s.active], ['Needs you', s.needsYou], ['Errors', s.errors], ['Completed', s.completed], ['Sessions', s.total]].map(([l, v]) => `<div class="metric"><b>${fmtNum(v)}</b><span>${l}</span></div>`).join('');
}
function renderList() {
  const rows = (DATA.sessions || []).filter(s => filter === 'all' || (filter === 'open' && ['active', 'needs_you', 'error'].includes(s.status)) || s.status === filter);
  $('count').textContent = `${rows.length} shown`;
  $('sessions').innerHTML = rows.map(s => `<button class="session ${selected === s.id ? 'selected' : ''}" data-id="${esc(s.id)}"><div><div class="session-title">${esc(s.title)}</div><div class="meta">${esc((s.agents || []).join(' + '))} · ${esc((s.models || []).join(', ') || 'model unknown')} · ${esc(s.channel || 'OpenClaw')}</div></div><div class="last">${esc(s.lastEvent || 'No normalized events')}</div><span class="badge ${esc(s.status)}">${esc(statusLabel(s.status))}</span><span class="age">${age(s.updatedAt)}</span><span class="arrow">›</span></button>`).join('') || '<div class="empty">No sessions match this filter.</div>';
  document.querySelectorAll('.session').forEach(b => b.onclick = () => openDrawer(b.dataset.id));
}
function render() { renderFilters(); renderSummary(); renderList(); }
function renderDrawer() {
  const s = session();
  if (!s) { if (selected) $('timeline').innerHTML = '<div class="empty">Session unavailable in the bounded session feed. Search Activity for historical runs.</div>'; return; }
  $('drawerTitle').textContent = s.title;
  $('drawerMeta').textContent = `${(s.agents || []).join(' + ')} · ${(s.harnesses || []).join(', ')} · ${(s.models || []).join(', ') || 'model unknown'} · ${fmtNum((s.inputTokens || 0) + (s.outputTokens || 0))} tokens`;
  $('drawerLinks').innerHTML = [s.slackAppUrl && `<a href="${esc(s.slackAppUrl)}">Open in Slack app</a>`, s.slackUrl && `<a href="${esc(s.slackUrl)}" target="_blank" rel="noreferrer">Open Slack web</a>`].filter(Boolean).join('');
  $('traceLevels').innerHTML = LEVELS.map(([k, v]) => `<button class="${level === k ? 'active' : ''}" data-level="${k}">${v}</button>`).join('');
  document.querySelectorAll('[data-level]').forEach(b => b.onclick = () => { level = b.dataset.level; renderDrawer(); });
  const runs = [...new Set((s.events || []).map(e => e.runId).filter(Boolean))];
  $('run').innerHTML = `<option value="">All observed runs</option><option value="unknown">Run unavailable</option>${runs.map(id => `<option value="${esc(id)}">${esc(id)}</option>`).join('')}`;
  $('run').value = run;
  $('policy').textContent = `${DATA.tracePolicy?.[level] || ''} · Sanitized trace; hidden chain-of-thought is never exposed.`;
  const events = (s.events || []).filter(e => allowed[level].has(e.level || 'normal')).filter(e => !run || (run === 'unknown' ? !e.runId : e.runId === run)).map(e => ({...e, logicalSessionId: s.id}));
  renderTrace($('timeline'), events.slice().reverse());
  $('coverage').innerHTML = `${s.traceTruncated ? 'Recent events only. ' : ''}${esc(s.eventCount)} observed events. <a href="/activity/?${esc(new URLSearchParams({session: s.id, ...(run && run !== 'unknown' ? {run} : {})}))}">Search complete activity history</a>`;
}
function openDrawer(id) { selected = id; syncUrl(); $('drawer').classList.add('open'); $('scrim').classList.add('open'); renderList(); renderDrawer(); }
function closeDrawer() { selected = null; run = ''; syncUrl(); $('drawer').classList.remove('open'); $('scrim').classList.remove('open'); renderList(); }
$('close').onclick = closeDrawer; $('scrim').onclick = closeDrawer;
$('run').addEventListener('change', () => { run = $('run').value; syncUrl(); renderDrawer(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
async function load() {
  try {
    const r = await fetch('/sessions/data.json', {cache: 'no-store'});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    DATA = await r.json();
    $('updated').textContent = `${freshness(DATA)} · updated ${age(DATA.generatedAt)} ago`;
    const source = DATA.sources?.[0] || {};
    $('source').textContent = `${source.label || 'Session ledger'} · ${fmtNum(source.events || 0)} events`;
    render();
    if (selected && !$('drawer').classList.contains('open')) openDrawer(selected); else if (selected) renderDrawer();
  } catch (err) { $('updated').textContent = `feed unavailable · ${err.message}`; }
}
load();
setInterval(load, 5000);
setInterval(() => { if (DATA.generatedAt) $('updated').textContent = `${freshness(DATA)} · updated ${age(DATA.generatedAt)} ago`; }, 1000);
