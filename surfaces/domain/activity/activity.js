import {escapeHtml as esc, freshness, matches, renderTrace, sessionLink} from './trace.js';
const form = document.getElementById('filters');
let manifest;
let loadError = null;
let request = 0;
const cache = new Map();
const params = new URLSearchParams(location.search);
async function json(url) {
  const response = await fetch(url, {cache: 'no-store'});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
function health(error = null) {
  loadError = error;
  document.getElementById('health').textContent = error ? `Unavailable · ${error.message}` : `${freshness(manifest)} · built ${manifest.generatedAt} · ${manifest.eventCount} observed events`;
}
async function render() {
  const ticket = ++request;
  const filters = Object.fromEntries(new FormData(form));
  if (params.has('session')) filters.session = params.get('session');
  if (params.has('run')) filters.run = params.get('run');
  if (filters.from && filters.to && filters.from > filters.to) { health(new Error('From date is after through date')); return; }
  try {
    const days = manifest.days.filter(day => (!filters.from || day.day >= filters.from) && (!filters.to || day.day <= filters.to));
    const all = [];
    for (const day of days) {
      if (!/^days\/\d{4}-\d{2}-\d{2}-[a-f0-9]{64}\.json$/.test(day.file)) throw new Error('Invalid partition reference');
      if (!cache.has(day.file)) cache.set(day.file, await json(`/activity/${day.file}`));
      all.push(...cache.get(day.file));
    }
    if (ticket !== request) return;
    const rows = all.filter(row => matches(row, filters)).reverse();
    renderTrace(document.getElementById('timeline'), rows);
    document.getElementById('coverage').textContent = `${rows.length} matching events · ${manifest.unindexedEvents} legacy events have no activity envelope. Missing observations remain unavailable.`;
    const spend = manifest.spend.filter(s => matches({ts:s.day, actor:{identity:s.identity}}, {from:filters.from,to:filters.to,identity:filters.identity}));
    document.getElementById('spend').innerHTML = spend.length ? `<table><caption>All cost reports for the selected dates and identity; action filters do not change spend.</caption><thead><tr><th>Day</th><th>Identity / profile</th><th>Currency</th><th>Exact</th><th>Estimated</th><th>Unavailable reports</th></tr></thead><tbody>${spend.map(s=>`<tr><td>${esc(s.day)}</td><td>${esc(s.identity)} / ${esc(s.profileId)}</td><td>${esc(s.currency || 'Unavailable')}</td><td>${s.currency ? esc(s.exact) : '—'}</td><td>${s.currency ? esc(s.estimated) : '—'}</td><td>${esc(s.unavailable)}</td></tr>`).join('')}</tbody></table>` : '<p>Cost unavailable: no reports for this range.</p>';
    document.getElementById('lineage').innerHTML = manifest.lineage.map(m=>`<article><strong>${esc(m.claimId)}</strong> · ${esc(m.state)} · ${esc(m.visibility)}<br>Introduced by ${m.introducedBy ? `<a href="/activity/?event=${encodeURIComponent(m.introducedBy)}#event-${encodeURIComponent(m.introducedBy)}">${esc(m.introducedBy)}</a>` : 'unavailable'} · projections: ${esc(m.projections.join(', ') || 'none')}<br>Supersedes: ${esc(m.supersedes.join(', ') || 'none')} · <a href="${esc(sessionLink(m.sessionId || m.mutationSessionId))}">${m.sessionId ? 'Origin session' : 'Introduction unavailable · mutation session'}</a></article>`).join('') || '<p>Lineage unavailable: no observed memory mutations.</p>';
    health();
  } catch (error) { if (ticket === request) health(error); }
}
form.addEventListener('submit', event => { event.preventDefault(); render(); });
try {
  manifest = await json('/activity/data.json');
  if (manifest.days.length) {
    form.elements.from.value = manifest.days.at(-1).day;
    form.elements.to.value = manifest.days.at(-1).day;
    if (params.has('session') || params.has('event')) form.elements.from.value = manifest.days[0].day;
  }
  await render();
} catch (error) { health(error); }
setInterval(() => { if (manifest && !loadError) health(); }, 30000);
