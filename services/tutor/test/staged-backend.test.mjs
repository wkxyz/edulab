import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Tutor} from '../service.mjs';
import {configFromEnv} from '../config.mjs';
import {validateInput} from '../validation.mjs';
import {startServer} from '../server.mjs';

const paidOptions={stageQuota:true,liveEnabled:true,configured:true,lessonTaskLimit:20,narrationTaskLimit:20,lessonDailyLimit:20,narrationDailyLimit:20};
function fixture(options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'staged-backend-'));
 const x={dir,tutor:new Tutor({dataDir:dir,autoRun:false,...paidOptions,...options}),close(){this.tutor.close();fs.rmSync(dir,{recursive:true,force:true});}};
 return x;
}
const lessonResult={format:'lesson',title:'原题',problem:'二加二',answer:'四',steps:[],audioReady:false,videoReady:false,previewReady:true,coverReady:false};
const voicedResult={...lessonResult,format:'video',audioReady:true};
const stored=(tutor,id)=>tutor.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);

test('default lesson cannot request speech or MP4; interactive video is rejected',()=>{
 assert.equal(validateInput({text:'原题'}).delivery,'lesson');
 assert.equal(validateInput({text:'原题',exportVideo:true}).exportVideo,false);
 assert.equal(validateInput({text:'原题',delivery:'video'}).exportVideo,false);
 assert.equal(validateInput({text:'原题',delivery:'video',exportVideo:true}).exportVideo,true);
 for(const capability of ['solid-geometry','analytic-geometry','chem-reaction'])assert.throws(()=>validateInput({text:'原题',capability,delivery:'video'}),/INVALID_DELIVERY/);
 assert.throws(()=>validateInput({text:'原题',delivery:'audio'}),/INVALID_DELIVERY/);
});
test('runtime configuration closes both paid stages and caps cumulative reserves at twenty yuan',()=>{
 const c=configFromEnv({});
 assert.equal(c.stageQuota,true);assert.equal(c.projectBudgetCents,2000);
 assert.equal(c.lessonBudgetCents,100);assert.equal(c.narrationBudgetCents,200);
 assert.equal(c.lessonTaskLimit,0);assert.equal(c.narrationTaskLimit,0);
 assert.equal(c.lessonDailyLimit,20);assert.equal(c.narrationDailyLimit,20);
 assert.throws(()=>configFromEnv({PROJECT_BUDGET_CENTS:'2001'}),/PROJECT_BUDGET_CENTS/);
});
test('narration maps every capability, reuses owned checked output, and is source-idempotent',async()=>{
 const mappings={'math-video':'math-video','physics-video':'physics-video','chem-video':'chem-video','solid-geometry':'math-video','analytic-geometry':'math-video','chem-reaction':'chem-video'};
 const x=fixture({dailyLimit:30,sampleOwnerLimit:30,runner:async task=>task.mode==='narration'?voicedResult:{...lessonResult,format:['solid-geometry','analytic-geometry','chem-reaction'].includes(task.input.capability)?'interactive':'lesson'}});
 try{
  for(const [capability,mapped] of Object.entries(mappings)){
   const source=x.tutor.create({capability,sampleId:'default'},'alice','source-'+capability);
   await x.tutor.run(source.id);const before=stored(x.tutor,source.id);
   assert.throws(()=>x.tutor.createNarration(source.id,'bob'),/NOT_FOUND/);
   assert.throws(()=>x.tutor.createExport(source.id,'alice'),/EXPORT_NOT_AVAILABLE/);
   const narration=x.tutor.createNarration(source.id,'alice');
   assert.equal(narration.mode,'narration');assert.equal(narration.capability,mapped);
   assert.equal(narration.sourceTaskId,source.id);assert.equal(narration.narrationOf,source.id);assert.equal(narration.sourceMode,'sample');
   assert.equal(x.tutor.createNarration(source.id,'alice').id,narration.id);
   const row=stored(x.tutor,narration.id),input=JSON.parse(row.input);
   assert.equal(row.reserve,0);assert.equal(input.delivery,'video');assert.equal(input.exportVideo,false);
   assert.equal(input.sourceCapability,capability);assert.equal(input.sourceResult.answer,'四');
   await x.tutor.run(narration.id);
   assert.equal(x.tutor.createNarration(narration.id,'alice').id,narration.id);
   assert.deepEqual(stored(x.tutor,source.id),before);
  }
  assert.equal(x.tutor.budget().reservedCents,0);
 }finally{x.close();}
});
test('legacy voiced results return their original task and never create another narration',async()=>{
 const x=fixture({runner:async()=>({format:'video',title:'旧视频',answer:'四',videoReady:true})});
 try{const source=x.tutor.create({sampleId:'equation'},'a','old');await x.tutor.run(source.id);assert.equal(x.tutor.createNarration(source.id,'a').id,source.id);assert.equal(x.tutor.list('a').length,1);}finally{x.close();}
});
test('paid narration has the persistent provider guards while free narration cannot call providers',async()=>{
 const x=fixture({runner:async(task,ctx)=>{
  if(task.mode!=='narration')return lessonResult;
  for(let n=0;n<15;n++)ctx.guard(true);
  return voicedResult;
 }});
 try{
  const source=x.tutor.create({text:'二加二'},'a','live');await x.tutor.run(source.id);
  const narration=x.tutor.createNarration(source.id,'a');await x.tutor.run(narration.id);await x.tutor.run(narration.id);
  const paid=stored(x.tutor,narration.id);
  assert.equal(paid.calls,14);assert.equal(paid.requests,14);assert.equal(paid.attempts,1);assert.equal(paid.error,'CALL_LIMIT');assert.equal(paid.reserve,200);
  const freeSource=x.tutor.create({sampleId:'equation'},'b','free');await x.tutor.run(freeSource.id);
  const free=x.tutor.createNarration(freeSource.id,'b');await x.tutor.run(free.id);
  const row=stored(x.tutor,free.id);assert.equal(row.calls,0);assert.equal(row.requests,0);assert.equal(row.error,'CALL_LIMIT');assert.equal(row.reserve,0);
 }finally{x.close();}
});
test('paid narration caps status reads independently of its fourteen paid calls',async()=>{
 const x=fixture({runner:async(task,ctx)=>{
  if(task.mode!=='narration')return lessonResult;
  for(let n=0;n<172;n++)ctx.guard('read');
  return voicedResult;
 }});
 try{const source=x.tutor.create({text:'原题'},'a','s');await x.tutor.run(source.id);const n=x.tutor.createNarration(source.id,'a');await x.tutor.run(n.id);const row=stored(x.tutor,n.id);assert.equal(row.calls,0);assert.equal(row.requests,171);assert.equal(row.error,'CALL_LIMIT');}finally{x.close();}
});
test('historical failed and cancelled reserves exhaust the cumulative cap across days and restart',()=>{
 const x=fixture({liveTaskLimit:2});
 try{
  for(let n=0;n<2;n++){
   const old=x.tutor.create({sampleId:'equation'},'history','history-'+n);
   x.tutor.db.prepare('UPDATE tasks SET mode=?,status=?,reserve=?,created=?,input=? WHERE id=?').run('live',n?'cancelled':'failed',1000,Date.now()-3*86400000,JSON.stringify({text:'历史原题',capability:'math-video',style:'whiteboard',exportVideo:true}),old.id);
  }
  const before=x.tutor.db.prepare('SELECT id,input,reserve,status FROM tasks ORDER BY id').all();
  assert.equal(x.tutor.budget().reservedCents,2000);assert.equal(x.tutor.budget().remainingCents,0);
  assert.throws(()=>x.tutor.create({text:'新题'},'new-owner','new'),/PROJECT_BUDGET_EXHAUSTED/);
  assert.equal(x.tutor.health().stages.lesson.reason,'PROJECT_BUDGET_EXHAUSTED');
  x.tutor.close();x.tutor=new Tutor({dataDir:x.dir,autoRun:false,...paidOptions,liveTaskLimit:2});
  assert.equal(x.tutor.budget().reservedCents,2000);
  assert.throws(()=>x.tutor.create({text:'另一题'},'another','new'),/PROJECT_BUDGET_EXHAUSTED/);
  assert.deepEqual(x.tutor.db.prepare('SELECT id,input,reserve,status FROM tasks ORDER BY id').all(),before);
  assert.equal(x.tutor.create({sampleId:'equation'},'free','new').mode,'sample');
 }finally{x.close();}
});
test('separate paid stage quotas ignore the obsolete shared cap and reserve direct video atomically',async()=>{
 const x=fixture({liveTaskLimit:0,lessonTaskLimit:1,narrationTaskLimit:1,runner:async()=>lessonResult});
 try{
  const source=x.tutor.create({text:'原题'},'a','s');assert.equal(stored(x.tutor,source.id).reserve,100);await x.tutor.run(source.id);
  assert.equal(x.tutor.health().stages.lesson.reason,'LESSON_LIMIT');assert.equal(x.tutor.health().stages.narration.available,true);
  const narration=x.tutor.createNarration(source.id,'a');assert.equal(stored(x.tutor,narration.id).reserve,200);
  assert.equal(x.tutor.health().stages.narration.reason,'NARRATION_LIMIT');
  assert.equal(x.tutor.createNarration(source.id,'a').id,narration.id);
  assert.equal(x.tutor.budget().reservedCents,300);
 }finally{x.close();}
 const direct=fixture();
 try{const task=direct.tutor.create({text:'原题',delivery:'video'},'a','v');assert.equal(stored(direct.tutor,task.id).reserve,300);assert.equal(direct.tutor.stageUsage('lesson'),1);assert.equal(direct.tutor.stageUsage('narration'),1);}finally{direct.close();}
 const blocked=fixture({narrationTaskLimit:0});
 try{assert.throws(()=>blocked.tutor.create({text:'原题',delivery:'video'},'a','v'),/NARRATION_LIMIT/);assert.equal(blocked.tutor.budget().reservedCents,0);assert.equal(blocked.tutor.list('a').length,0);}finally{blocked.close();}
});
test('free quotas, paid daily stage quotas and paid owner stage quotas remain independent',async()=>{
 const x=fixture({dailyLimit:1,sampleOwnerLimit:1,ownerLimit:1,runner:async task=>task.mode==='narration'?voicedResult:lessonResult});
 try{
  const sample=x.tutor.create({sampleId:'equation'},'a','free');await x.tutor.run(sample.id);
  assert.throws(()=>x.tutor.create({sampleId:'equation'},'b','free'),/PROJECT_LIMIT/);
  const source=x.tutor.create({text:'原题'},'a','paid');await x.tutor.run(source.id);
  assert.throws(()=>x.tutor.create({text:'第二题'},'a','paid-two'),/OWNER_LIMIT/);
  const narration=x.tutor.createNarration(source.id,'a');assert.equal(narration.mode,'narration');
  assert.equal(x.tutor.stageUsage('lesson'),1);assert.equal(x.tutor.stageUsage('narration'),1);
 }finally{x.close();}
 const daily=fixture({lessonDailyLimit:1});
 try{daily.tutor.create({text:'原题'},'a','one');assert.equal(daily.tutor.health().stages.lesson.reason,'LESSON_DAILY_LIMIT');assert.throws(()=>daily.tutor.create({text:'第二题'},'b','two'),/LESSON_DAILY_LIMIT/);assert.equal(daily.tutor.health().stages.narration.available,true);}finally{daily.close();}
});
test('legacy missing-delivery idempotency is normalized without rewriting the row',()=>{
 const x=fixture();
 try{const task=x.tutor.create({sampleId:'equation'},'a','old');const legacy=JSON.stringify({sampleId:'equation',style:'whiteboard'});x.tutor.db.prepare('UPDATE tasks SET input=? WHERE id=?').run(legacy,task.id);assert.equal(x.tutor.create({sampleId:'equation'},'a','old').id,task.id);assert.equal(stored(x.tutor,task.id).input,legacy);}finally{x.close();}
});
test('export reuses a narrated source and cannot call providers or alter its original lesson',async()=>{
 const x=fixture({runner:async(task,ctx)=>{
  if(task.mode==='export'){assert.equal(task.input.sourceResult.answer,'四');assert.throws(()=>ctx.guard(true),/CALL_LIMIT/);return {...voicedResult,videoReady:true};}
  return task.mode==='narration'?voicedResult:lessonResult;
 }});
 try{
  const source=x.tutor.create({sampleId:'equation'},'a','s');await x.tutor.run(source.id);const before=stored(x.tutor,source.id);
  const narration=x.tutor.createNarration(source.id,'a');await x.tutor.run(narration.id);
  const exported=x.tutor.createExport(narration.id,'a');assert.equal(exported.sourceTaskId,narration.id);assert.equal(exported.narrationOf,source.id);assert.equal(exported.sourceMode,'sample');
  assert.equal(JSON.parse(stored(x.tutor,exported.id).input).exportOf,narration.id);
  assert.equal(x.tutor.createExport(narration.id,'a').id,exported.id);await x.tutor.run(exported.id);
  assert.match(x.tutor.get(exported.id,'a').result.video,/video.mp4/);assert.equal(x.tutor.budget().reservedCents,0);assert.deepEqual(stored(x.tutor,source.id),before);
 }finally{x.close();}
});
test('HTTP narration ignores forged body, checks ownership, and reports cumulative budget',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'staged-http-'));
 const app=await startServer({dataDir:dir,port:0,autoRun:false,...paidOptions,runner:async task=>task.mode==='narration'?voicedResult:lessonResult});
 const base='http://127.0.0.1:'+app.server.address().port;
 try{
  const session=await fetch(base+'/api/session',{method:'POST'}).then(r=>r.json());
  const source=app.tutor.create({sampleId:'equation'},session.token,'s');await app.tutor.run(source.id);
  const headers={authorization:'Bearer '+session.token,'content-type':'application/json'};
  const response=await fetch(base+'/api/tasks/'+source.id+'/narration',{method:'POST',headers,body:JSON.stringify({sourceMode:'live',sourceResult:{answer:'篡改'},capability:'chem-video',exportVideo:true})});
  assert.equal(response.status,202);const task=await response.json(),input=JSON.parse(stored(app.tutor,task.id).input);
  assert.equal(input.sourceMode,'sample');assert.equal(input.sourceResult.answer,'四');assert.equal(input.capability,'math-video');assert.equal(input.exportVideo,false);
  const other=await fetch(base+'/api/session',{method:'POST'}).then(r=>r.json());
  assert.equal((await fetch(base+'/api/tasks/'+source.id+'/narration',{method:'POST',headers:{authorization:'Bearer '+other.token}})).status,404);
  const health=await fetch(base+'/api/health').then(r=>r.json());
  assert.equal(health.stages.lesson.reserveCents,100);assert.equal(health.stages.narration.reserveCents,200);
  assert.deepEqual(health.budget,{currency:'CNY',kind:'cumulative-reservation',limitCents:2000,reservedCents:0,remainingCents:2000});
 }finally{await new Promise(resolve=>app.server.close(resolve));app.tutor.close();fs.rmSync(dir,{recursive:true,force:true});}
});
