import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const mod=await import('../server.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
test('HTTP session, real configuration failure, owner boundary and cancellation',async()=>{
 assert.equal(typeof mod.startServer,'function','HTTP server must exist');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tutor-http-'));
 const {server,tutor}=await mod.startServer({dataDir:dir,port:0,autoRun:false});
 const base=`http://127.0.0.1:${server.address().port}`;
 const req=async(url,{token,body,method='GET',key}={})=>{const r=await fetch(base+url,{method,headers:{...(token?{authorization:`Bearer ${token}`} : {}),...(body?{'content-type':'application/json'}:{}),...(key?{'idempotency-key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
 try{
 const a=(await req('/api/session',{method:'POST'})).data.token,b=(await req('/api/session',{method:'POST'})).data.token;
 assert.equal((await req('/api/tasks')).status,401);
 assert.equal((await req('/api/tasks',{method:'POST',token:a,key:'live',body:{text:'求二加二'}})).status,503);
 const created=await req('/api/tasks',{method:'POST',token:a,key:'sample',body:{sampleId:'equation'}});assert.equal(created.status,202);
 const id=created.data.id;assert.equal((await req(`/api/tasks/${id}`,{token:b})).status,404);
 assert.equal((await req(`/api/tasks/${id}/cancel`,{token:a,method:'POST'})).data.status,'cancelled');
 assert.equal((await req('/api/tasks',{token:b})).data.tasks.length,0);
 assert.equal((await req('/api/tasks',{method:'POST',token:a,key:'bad',body:{image:'data:image/png;base64,AAAA'}})).status,400);
 }finally{await new Promise(r=>server.close(r));tutor.close();fs.rmSync(dir,{recursive:true,force:true});}
});
