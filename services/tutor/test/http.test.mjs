import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const mod=await import('../server.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
test('HTTP session, real configuration failure, owner boundary and cancellation',async()=>{
 assert.equal(typeof mod.startServer,'function','HTTP server must exist');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tutor-http-'));
 const admin='test-admin-token-32-characters-long';
 const {server,tutor}=await mod.startServer({dataDir:dir,port:0,autoRun:false,adminToken:admin});
 const base=`http://127.0.0.1:${server.address().port}`;
 const req=async(url,{token,body,method='GET',key}={})=>{const r=await fetch(base+url,{method,headers:{...(token?{authorization:`Bearer ${token}`} : {}),...(body?{'content-type':'application/json'}:{}),...(key?{'idempotency-key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
 try{
 for(const asset of ['/ui.mjs','/photo-editor.mjs']){const r=await fetch(base+asset);assert.equal(r.status,200,asset);assert.match(r.headers.get('content-type'),/javascript/);assert.match(await r.text(),/export /);}
 const a=(await req('/api/session',{method:'POST'})).data.token,b=(await req('/api/session',{method:'POST'})).data.token;
 assert.equal((await req('/api/tasks')).status,401);
 assert.equal((await req('/api/tasks',{method:'POST',token:a,key:'live',body:{text:'求二加二'}})).status,503);
 const created=await req('/api/tasks',{method:'POST',token:a,key:'sample',body:{sampleId:'equation'}});assert.equal(created.status,202);
 const id=created.data.id;assert.equal((await req(`/api/tasks/${id}`,{token:b})).status,404);
 assert.equal((await req(`/api/tasks/${id}/cancel`,{token:a,method:'POST'})).data.status,'cancelled');
 assert.equal((await req('/api/tasks',{token:b})).data.tasks.length,0);
 assert.equal((await req('/api/tasks',{method:'POST',token:a,key:'bad',body:{image:'data:image/png;base64,AAAA'}})).status,400);
 assert.equal((await req('/api/admin/state',{method:'POST',token:a,body:{stopped:true}})).status,403);
 assert.equal((await req('/api/admin/state',{method:'POST',token:admin,body:{stopped:true}})).data.stopped,true);
 assert.equal((await req('/api/session',{method:'POST'})).status,503);
 assert.equal((await req('/api/tasks',{token:a})).status,503);
 assert.equal((await req('/api/tasks',{method:'POST',token:a,key:'stopped',body:{sampleId:'equation'}})).status,503);
 assert.equal((await req('/api/admin/state',{method:'POST',token:admin,body:{stopped:false}})).data.stopped,false);
 assert.equal((await req('/api/health')).data.stopped,false);
 }finally{await new Promise(r=>server.close(r));tutor.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('public health stops advertising paid generation after the cumulative trial is used',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tutor-quota-health-'));
 const {server,tutor}=await mod.startServer({dataDir:dir,port:0,autoRun:false,liveEnabled:true,configured:true,liveTaskLimit:1,dayBudgetCents:1000,jobBudgetCents:1000});
 const health=async()=>fetch(`http://127.0.0.1:${server.address().port}/api/health`).then(r=>r.json());
 try{
  assert.equal((await health()).liveEnabled,true);
  tutor.create({text:'解方程三乘以未知数减七等于八'},'trial-owner','one');
  const h=await health();assert.equal(h.liveEnabled,false);assert.equal(h.liveLimitReached,true);assert.equal(h.stopped,false);assert.equal(h.sampleAvailable,true);
 }finally{await new Promise(r=>server.close(r));tutor.close();fs.rmSync(dir,{recursive:true,force:true});}
});
