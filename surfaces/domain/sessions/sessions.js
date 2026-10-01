import {escapeHtml as esc, freshness, renderTrace} from '../activity/trace.js';
const sessionSelect = document.getElementById('session');
const runSelect = document.getElementById('run');
const params = new URLSearchParams(location.search);
let selected = params.get('session'), run = params.get('run') || '', data;
function render() {
  const session = data.sessions.find(s => s.id === selected);
  if (!session) { document.getElementById('trace').textContent = 'Session unavailable in the bounded session feed. Search Activity for historical runs.'; return; }
  const runs = [...new Set(session.events.map(e => e.runId).filter(Boolean))];
  runSelect.innerHTML = `<option value="">All observed runs</option><option value="unknown">Run unavailable</option>${runs.map(id=>`<option value="${esc(id)}">${esc(id)}</option>`).join('')}`;
  runSelect.value = run;
  renderTrace(document.getElementById('trace'), session.events.filter(e=>!run || (run === 'unknown' ? !e.runId : e.runId === run)).map(e=>({...e,logicalSessionId:session.id})));
  document.getElementById('coverage').innerHTML = `${session.traceTruncated ? 'Recent events only. ' : ''}${esc(session.eventCount)} observed events. <a href="/activity/?${esc(new URLSearchParams({session:session.id,...(run && run !== 'unknown' ? {run} : {})}))}">Search complete activity history</a>`;
}
sessionSelect.addEventListener('change', () => { selected = sessionSelect.value; run = ''; render(); });
runSelect.addEventListener('change', () => { run = runSelect.value; render(); });
async function load() {
  try {
    const response = await fetch('/sessions/data.json', {cache:'no-store'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = await response.json();
    sessionSelect.innerHTML = data.sessions.map(s=>`<option value="${esc(s.id)}">${esc(s.title)} · ${esc(s.status)}</option>`).join('');
    selected ||= data.sessions[0]?.id;
    sessionSelect.value = selected;
    document.getElementById('health').textContent = `${freshness(data)} · built ${data.generatedAt}`;
    render();
  } catch(error) { document.getElementById('health').textContent = `Unavailable · ${error.message}`; }
}
load();
setInterval(load, 15000);
