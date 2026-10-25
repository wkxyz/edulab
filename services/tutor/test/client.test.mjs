import test from 'node:test';import assert from 'node:assert/strict';
import {createClient} from '../../../apps/web/api-client.mjs';
test('parallel first requests use one session and keep task ownership',async()=>{
 let token=null,sessions=0;const owners=[];
 const api=createClient({storage:{getItem:()=>token,setItem:(k,v)=>{token=v;},removeItem:()=>{token=null;}},transport:async(url,opts)=>{
  if(url==='/api/session'){sessions++;await new Promise(r=>setImmediate(r));return Response.json({token:'session-'+sessions});}
  owners.push(opts.headers.authorization);return Response.json({ok:true});
 }});
 await Promise.all([api('/api/tasks'),api('/api/tasks',{method:'POST',data:{sampleId:'equation'}})]);
 assert.equal(sessions,1);assert.deepEqual(owners,['Bearer session-1','Bearer session-1']);assert.equal(token,'session-1');
});

test('a stalled request times out with a recoverable message',async()=>{
 const api=createClient({storage:{getItem:()=>null},requestTimeoutMs:15,transport:async(url,options)=>new Promise((resolve,reject)=>{
  const keepAlive=setTimeout(()=>reject(new Error('request did not abort')),300);
  options.signal?.addEventListener('abort',()=>{clearTimeout(keepAlive);reject(options.signal.reason);},{once:true});
 })});
 await assert.rejects(api('/api/health',{auth:false}),error=>error.code==='NETWORK_TIMEOUT'&&/超时/.test(error.message));
});
