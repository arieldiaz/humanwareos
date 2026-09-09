#!/usr/bin/env node
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';

const root=await mkdtemp(path.join(tmpdir(),'humanware-docs-test-'));
const docs=path.join(root,'docs');
const proposals=path.join(root,'proposals');
await mkdir(docs);
await writeFile(path.join(docs,'hello.md'),'# Hello\n\nPrivate operating document.\n');
const config=path.join(root,'config.json');
await writeFile(config,JSON.stringify({schemaVersion:1,id:'docs',title:'Test',dataRoot:root,proposalDirectory:proposals,collections:[{id:'docs',label:'Docs',root:docs,extensions:['.md'],exclude:[]}]}));
const port=18787;
const child=spawn(process.execPath,[new URL('./document-workspace-server.mjs',import.meta.url).pathname,config],{env:{...process.env,HUMANWARE_DOCS_PORT:String(port)},stdio:'ignore'});
const base=`http://127.0.0.1:${port}`;
try{
  for(let attempt=0;attempt<30;attempt++){try{if((await fetch(`${base}/health`)).ok)break}catch{}await new Promise(resolve=>setTimeout(resolve,50))}
  const manifest=await (await fetch(`${base}/manifest`)).json();
  assert.equal(manifest.documents.length,1);
  assert.equal(manifest.documents[0].id,'docs:hello.md');
  const document=await (await fetch(`${base}/document?id=docs%3Ahello.md`)).json();
  assert.match(document.content,/Private operating document/);
  assert.equal((await fetch(`${base}/document?id=docs%3A..%2Fsecret.md`)).status,400);
  const created=await (await fetch(`${base}/proposals`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({documentId:document.id,sourceSha256:document.sha256,comment:'Clarify this sentence.'})})).json();
  assert.equal(created.status,'open');
  const event=JSON.parse(await readFile(path.join(proposals,`${created.id}.json`),'utf8'));
  assert.equal(event.document.currentSha256,document.sha256);
  assert.equal(event.comment,'Clarify this sentence.');
  process.stdout.write('document-workspace-server: tests passed\n');
}finally{child.kill('SIGTERM')}
