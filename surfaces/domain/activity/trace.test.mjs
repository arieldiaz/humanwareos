import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const code = readFileSync(new URL('./trace.js', import.meta.url), 'utf8');
const {escapeHtml, freshness, matches, renderTrace, runTreeHtml, sessionLink, traceHtml} = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const row = {id:'event-1', kind:'action.send', logicalSessionId:'session-1', runId:'run-2', ts:'2026-09-30T12:00:00Z',
  actor:{identity:'liv',profileId:'local'}, authority:{result:'human_message',ref:{type:'human_message',id:'message-1'}},
  policy:{result:'allowed',id:'workspace',version:'1'}, outcome:'succeeded', reversibility:'outward',
  sourceRef:{type:'raw',id:'raw-1',localOnly:true}, parentIds:['parent-1'], target:{type:'path',id:'working/report.md'}};
test('filters cover dates, identity, target, kind, run and consequential actions', () => {
  assert(matches(row,{identity:'liv',from:'2026-09-29',to:'2026-09-30',target:'report',kind:'send',run:'run-2',reversibility:'outward'}));
  for (const filter of [{identity:'max'},{from:'2026-10-01'},{to:'2026-09-29'},{run:'run-3'},{channel:'slack'}]) assert(!matches(row,filter));
});
test('freshness distinguishes unavailable, stale and current', () => {
  const now=Date.parse(row.ts);
  assert.equal(freshness(null,now),'Unavailable');
  assert.equal(freshness({generatedAt:row.ts},now),'Current');
  assert.equal(freshness({generatedAt:row.ts},now+120001),'Stale');
});
test('session and run navigation safely encodes identifiers', () => {
  const url=new URL(sessionLink('session:one','run/2'),'https://example.test');
  assert.equal(url.pathname,'/sessions/');
  assert.equal(url.searchParams.get('session'),'session:one');
  assert.equal(url.searchParams.get('run'),'run/2');
});
test('shared trace renders authority, policy, local reference and escapes hostile values', () => {
  globalThis.location={hash:''};
  const container={innerHTML:''};
  renderTrace(container,[row]);
  for (const text of ['consequential','message-1','workspace @ 1','raw-1 (local only)','parent-1','session-1']) assert(container.innerHTML.includes(text));
  const hostile=traceHtml({...row,target:{id:'<img src=x onerror=alert(1)>'},summary:'UNUSED PAYLOAD',details:{preview:'UNUSED PAYLOAD'}});
  assert(!hostile.includes('<img'));
  assert(!hostile.includes('UNUSED PAYLOAD'));
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  assert(!container.innerHTML.includes('href="raw'));
});
test('run tree shows nested workers, unavailable values and escaped identifiers', () => {
  const html=runTreeHtml([{runId:'run-1',sessionId:'child-1',model:'provider/model',reasoning:'high',status:'ok',durationMs:61000,tokens:{total:90},
    cost:{status:'estimated',amount:0.5,currency:'USD'},children:[{runId:'<b>run-2',sessionId:'child-2',model:null,status:null,durationMs:null,tokens:{},cost:{status:'unavailable'},children:[]}]}],
    [{currency:'USD',exact:0,estimated:0.5,unavailable:1}]);
  for (const text of ['provider/model','high','61s','90 tokens','0.5 USD estimated','<ul>','not completed','tokens unavailable','cost unavailable','0.5 USD estimated, 1 unavailable']) assert(html.includes(text), text);
  assert(!html.includes('<b>run-2'));
  assert(runTreeHtml([],[]).includes('No worker runs observed'));
});
