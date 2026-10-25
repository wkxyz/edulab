import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {validateInput} from '../validation.mjs';import {Tutor} from '../service.mjs';import {startServer} from '../server.mjs';import {solveStructured} from '../ai.mjs';
import {CAPABILITIES} from '../../../apps/web/capabilities.mjs';
function fixture(options={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'capability-service-'));const tutor=new Tutor({dataDir:dir,autoRun:false,...options});return {dir,tutor,close(){tutor.close();fs.rmSync(dir,{recursive:true,force:true});}};}
test('all six task modes accept real text and isolate built-in examples from arbitrary input',()=>{
 for(const c of CAPABILITIES){const live=validateInput({capability:c.id,text:'这道原题',exportVideo:false});assert.equal(live.capability,c.id);assert.equal(live.text,'这道原题');const sample=validateInput({capability:c.id,sampleId:'default'});assert.equal(sample.sampleId,'default');if(c.kind==='interactive')assert.equal(validateInput({capability:c.id,sampleId:'random'}).sampleId,'random');else assert.throws(()=>validateInput({capability:c.id,sampleId:'random'}),/INVALID_SAMPLE/);}
 assert.throws(()=>validateInput({capability:'not-a-skill',text:'问题'}),/INVALID_CAPABILITY/);
 assert.throws(()=>validateInput({capability:'physics-video',text:'问题',style:'handdrawn'}),/INVALID_STYLE/);
 assert.throws(()=>validateInput({text:'问题',exportVideo:'false'}),/INVALID_INPUT/);
});
test('all live capabilities share the same persistent cumulative limit and reservation',()=>{
 const x=fixture({liveEnabled:true,configured:true,liveTaskLimit:2,dayBudgetCents:1000,jobBudgetCents:200});
 try{x.tutor.create({capability:'solid-geometry',text:'正方体'},'a','one');x.tutor.create({capability:'physics-video',text:'牛顿定律'},'b','two');assert.throws(()=>x.tutor.create({capability:'chem-video',text:'配平'},'c','three'),/LIVE_LIMIT/);assert.equal(x.tutor.db.prepare('SELECT cost FROM daily').get().cost,400);assert.equal(x.tutor.db.prepare("SELECT count(*) n FROM tasks WHERE mode='live'").get().n,2);}finally{x.close();}
});
test('trying six free modules does not spend or exhaust the five paid tasks per owner',()=>{
 const x=fixture({liveEnabled:true,configured:true,liveTaskLimit:5,queueLimit:20,dayBudgetCents:1000,jobBudgetCents:100});
 try{for(const c of CAPABILITIES)x.tutor.create({capability:c.id,sampleId:'default'},'a','sample-'+c.id);for(let i=0;i<5;i++)x.tutor.create({text:'解方程'},'a','live-'+i);assert.equal(x.tutor.db.prepare('SELECT cost FROM daily').get().cost,500);assert.throws(()=>x.tutor.create({text:'解方程'},'a','live-6'),/LIVE_LIMIT/);}finally{x.close();}
});
test('legacy stored idempotency inputs still match after capability defaults are introduced',()=>{
 const x=fixture();try{const first=x.tutor.create({sampleId:'equation',style:'chalk'},'a','legacy');x.tutor.db.prepare('UPDATE tasks SET input=? WHERE id=?').run(JSON.stringify({sampleId:'equation',style:'chalk'}),first.id);assert.equal(x.tutor.create({sampleId:'equation',style:'chalk'},'a','legacy').id,first.id);assert.equal(x.tutor.db.prepare('SELECT count(*) n FROM tasks').get().n,1);}finally{x.close();}
});
test('export creates a render-only task without resetting, resolving or charging the original',async()=>{
 let paid=0;const x=fixture({runner:async(task,ctx)=>{if(task.mode==='export')assert.equal(task.input.sourceResult.answer,'x=4');else assert.equal(task.mode,'sample');return {format:'video',title:'原题',answer:'x=4',steps:[],videoReady:task.mode==='export',previewReady:true};}});
 try{const source=x.tutor.create({sampleId:'equation',exportVideo:false},'a','source');await x.tutor.run(source.id);const before=x.tutor.db.prepare('SELECT attempts,calls,requests FROM tasks WHERE id=?').get(source.id);const exported=x.tutor.createExport(source.id,'a');assert.notEqual(exported.id,source.id);assert.equal(exported.mode,'export');assert.equal(x.tutor.createExport(source.id,'a').id,exported.id);await x.tutor.run(exported.id);assert.match(x.tutor.get(exported.id,'a').result.video,/video.mp4/);assert.deepEqual(x.tutor.db.prepare('SELECT attempts,calls,requests FROM tasks WHERE id=?').get(source.id),before);assert.equal(x.tutor.db.prepare("SELECT count(*) n FROM tasks WHERE mode='live'").get().n,0);assert.equal(x.tutor.db.prepare('SELECT cost FROM daily').get().cost,0);assert.throws(()=>x.tutor.createExport(source.id,'b'),/NOT_FOUND/);assert.equal(paid,0);}finally{x.close();}
});
test('interactive lessons cannot masquerade as exportable video tasks',async()=>{
 const x=fixture({runner:async()=>({format:'interactive',title:'几何',answer:'一',steps:[],previewReady:true})});
 try{const source=x.tutor.create({capability:'solid-geometry',sampleId:'default'},'a','one');await x.tutor.run(source.id);const result=x.tutor.get(source.id,'a').result;assert.equal(result.video,undefined);assert.match(result.preview,/preview.html/);assert.throws(()=>x.tutor.createExport(source.id,'a'),/EXPORT_NOT_AVAILABLE/);}finally{x.close();}
});
test('public previews are token protected, sandboxed and downloadable without exposing arbitrary files',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'capability-http-'));
 const app=await startServer({dataDir:dir,port:0,autoRun:false,runner:async task=>{const out=path.join(dir,'jobs',task.id);fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'preview.html'),'<!doctype html><canvas></canvas>');fs.writeFileSync(path.join(out,'lesson.html'),'<!doctype html><canvas></canvas>');return {format:'interactive',title:'几何',answer:'一',steps:[],coverReady:false,previewReady:true};}});
 const base='http://127.0.0.1:'+app.server.address().port;
 try{const session=await fetch(base+'/api/session',{method:'POST'}).then(r=>r.json());const headers={authorization:'Bearer '+session.token,'content-type':'application/json','idempotency-key':'one'};const task=await fetch(base+'/api/tasks',{method:'POST',headers,body:JSON.stringify({capability:'solid-geometry',sampleId:'default'})}).then(r=>r.json());await app.tutor.run(task.id);const done=app.tutor.get(task.id,session.token);const preview=await fetch(base+done.result.preview);assert.equal(preview.status,200);assert.match(preview.headers.get('content-security-policy'),/sandbox allow-scripts/);assert.doesNotMatch(preview.headers.get('content-security-policy'),/allow-same-origin/);assert.equal((await fetch(base+done.result.preview.replace(/token=.*/,'token=wrong'))).status,404);assert.equal((await fetch(base+'/api/media/'+task.id+'/.env?token=wrong',{headers:{authorization:'Bearer '+session.token}})).status,404);const download=await fetch(base+done.result.download);assert.match(download.headers.get('content-disposition'),/attachment/);const listed=await fetch(base+'/api/capabilities').then(r=>r.json());assert.equal(listed.capabilities.length,6);}finally{await new Promise(r=>app.server.close(r));app.tutor.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('independent review compares original text, image, parsed parameters and computed result before speech',async()=>{
 const original=globalThis.fetch;let n=0,review;
 globalThis.fetch=async(url,opts)=>{n++;const body=JSON.parse(opts.body);if(n===2)review=JSON.stringify(body.messages);return Response.json({choices:[{message:{content:JSON.stringify(n===1?{body:'cube',dims:{edge:3},query:{type:'volume'}}:{correct:false})}}]});};
 try{await assert.rejects(()=>solveStructured({capability:'solid-geometry',text:'棱长四的正方体体积',image:'data:image/png;base64,abc'},{aiBase:'https://mock.invalid',aiKey:'mock',aiModel:'mock'},{guard(){},stage(){},signal:new AbortController().signal},{instructions:'typed',materialize:async()=>({answer:'27'})}),/REVIEW_FAILED/);assert.equal(n,2);assert.match(review,/棱长四/);assert.match(review,/parsedSpecification/);assert.match(review,/"edge":3|\\"edge\\":3/);assert.match(review,/data:image/);}finally{globalThis.fetch=original;}
});
