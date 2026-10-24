import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mod = await import('../service.mjs').catch(e => {if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const make = (opts={}) => {
  assert.equal(typeof mod.Tutor, 'function', 'persistent task service must exist');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tutor-test-'));
  const tutor=new mod.Tutor({dataDir:dir,autoRun:false,...opts});
  return {tutor,dir,done:()=>{tutor.close();fs.rmSync(dir,{recursive:true,force:true});}};
};
const sample={sampleId:'equation',style:'whiteboard'};

test('duplicate submission consumes one task and survives restart',()=>{
 const x=make(); try {
  const a=x.tutor.create(sample,'alice','same-key');
  assert.equal(x.tutor.create(sample,'alice','same-key').id,a.id);
  x.tutor.close(); const reopened=new mod.Tutor({dataDir:x.dir,autoRun:false});
  assert.equal(reopened.create(sample,'alice','same-key').id,a.id); reopened.close();
 } finally {x.done();}
});
test('owners cannot read, cancel or list each other tasks',()=>{
 const x=make();try {const a=x.tutor.create(sample,'alice','a');
 assert.equal(x.tutor.get(a.id,'bob'),null);
 assert.deepEqual(x.tutor.list('bob'),[]);
 assert.throws(()=>x.tutor.cancel(a.id,'bob'),/NOT_FOUND/);
 } finally {x.done();}
});
test('project-wide limit cannot be bypassed by another owner or restart',()=>{
 const x=make({dailyLimit:2,ownerLimit:2}); try {
 x.tutor.create(sample,'a','1');x.tutor.create(sample,'b','1');
 assert.throws(()=>x.tutor.create(sample,'c','1'),/PROJECT_LIMIT/);
 x.tutor.close(); const b=new mod.Tutor({dataDir:x.dir,autoRun:false,dailyLimit:2,ownerLimit:2});
 assert.throws(()=>b.create(sample,'d','1'),/PROJECT_LIMIT/);b.close();
 }finally{x.done();}
});
test('per owner limit and total task count are separately enforced',()=>{
 const x=make({ownerLimit:1,totalLimit:2});try{
 x.tutor.create(sample,'a','1');assert.throws(()=>x.tutor.create(sample,'a','2'),/OWNER_LIMIT/);
 x.tutor.create(sample,'b','1');assert.throws(()=>x.tutor.create(sample,'c','1'),/TOTAL_LIMIT/);
 }finally{x.done();}
});
test('stop persists, blocks new work, and resume does not redo completed work',async()=>{
 let calls=0;const x=make({runner:async()=>{calls++;return {video:'video.mp4'};}});try{
 const a=x.tutor.create(sample,'a','1');x.tutor.setStopped(true);
 assert.throws(()=>x.tutor.create(sample,'b','1'),/STOPPED/);await x.tutor.run(a.id);
 assert.equal(calls,0);x.tutor.close();
 const b=new mod.Tutor({dataDir:x.dir,autoRun:false});assert.equal(b.isStopped(),true);b.close();
 x.tutor=new mod.Tutor({dataDir:x.dir,autoRun:false,runner:async()=>{calls++;return {video:'video.mp4'};}});
 x.tutor.setStopped(false);await x.tutor.run(a.id);await x.tutor.run(a.id);assert.equal(calls,1);
 }finally{x.done();}
});
test('permanent failure is terminal without automatic retries',async()=>{
 let calls=0;const x=make({runner:async()=>{calls++;throw new Error('PRIVATE_PROVIDER_SECRET');}});try{
 const a=x.tutor.create(sample,'a','1');await x.tutor.run(a.id);await x.tutor.run(a.id);
 assert.equal(calls,1);assert.equal(x.tutor.get(a.id,'a').status,'failed');
 assert.doesNotMatch(JSON.stringify(x.tutor.get(a.id,'a')),/PRIVATE_PROVIDER_SECRET/);
 }finally{x.done();}
});
test('empty queue makes no runner calls',async()=>{let calls=0;const x=make({runner:async()=>{calls++;}});try{await x.tutor.drain();assert.equal(calls,0);}finally{x.done();}});
test('jobs submitted during a full drain batch are eventually processed',async()=>{
 const releases=[];let started=0;const x=make({autoRun:true,queueLimit:2,runner:async()=>{started++;if(started<=2)await new Promise(r=>releases.push(r));return {};}});
 try{x.tutor.create(sample,'a','1');await new Promise(r=>setImmediate(r));x.tutor.create(sample,'b','1');releases.shift()();await new Promise(r=>setImmediate(r));const c=x.tutor.create(sample,'c','1');releases.shift()();await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));assert.equal(x.tutor.get(c.id,'c').status,'completed');assert.equal(started,3);}finally{x.done();}
});
test('live requests are rejected before enqueuing when not configured',()=>{const x=make();try{assert.throws(()=>x.tutor.create({text:'求二加二'},'a','1'),/NOT_CONFIGURED/);assert.equal(x.tutor.list('a').length,0);}finally{x.done();}});
test('cancel aborts current work and prevents a later stage',async()=>{
 let release;let later=0;const x=make({runner:async(task,ctx)=>{await new Promise(r=>{release=r;});ctx.guard();later++;return {};}});
 try {const a=x.tutor.create(sample,'a','1');const p=x.tutor.run(a.id);await new Promise(r=>setImmediate(r));
 x.tutor.cancel(a.id,'a');release();await p;assert.equal(later,0);assert.equal(x.tutor.get(a.id,'a').status,'cancelled');
 }finally{x.done();}
});
test('stop during execution aborts it before any further stage',async()=>{
 let release;let later=0;const x=make({runner:async(task,ctx)=>{await new Promise(r=>{release=r;});ctx.guard();later++;return {};}});
 try {const a=x.tutor.create(sample,'a','1');const p=x.tutor.run(a.id);await new Promise(r=>setImmediate(r));x.tutor.setStopped(true);release();await p;assert.equal(later,0);assert.equal(x.tutor.get(a.id,'a').status,'cancelled');}finally{x.done();}
});
test('project budget reservation survives restart and another device',()=>{
 const opts={liveEnabled:true,configured:true,dayBudgetCents:100,jobBudgetCents:60};const x=make(opts);
 try{x.tutor.create({text:'求二加二'},'a','1');assert.throws(()=>x.tutor.create({text:'求三加三'},'b','1'),/BUDGET_EXHAUSTED/);x.tutor.close();x.tutor=new mod.Tutor({dataDir:x.dir,autoRun:false,...opts});assert.throws(()=>x.tutor.create({text:'求四加四'},'c','1'),/BUDGET_EXHAUSTED/);}finally{x.done();}
});
test('one live task cannot make a fifteenth external call or retry it',async()=>{
 let calls=0;const x=make({liveEnabled:true,configured:true,dayBudgetCents:100,jobBudgetCents:10,runner:async(task,ctx)=>{for(let n=0;n<15;n++){ctx.guard(true);calls++;}}});
 try{const a=x.tutor.create({text:'求二加二'},'a','1');await x.tutor.run(a.id);await x.tutor.run(a.id);assert.equal(calls,14);assert.equal(x.tutor.get(a.id,'a').error,'CALL_LIMIT');}finally{x.done();}
});
test('expired queued work never reaches a provider',async()=>{
 let calls=0;const x=make({runner:async()=>{calls++;}});try{const a=x.tutor.create(sample,'a','1');x.tutor.db.prepare('UPDATE tasks SET expires=0 WHERE id=?').run(a.id);await x.tutor.run(a.id);assert.equal(calls,0);assert.equal(x.tutor.get(a.id,'a').error,'EXPIRED');}finally{x.done();}
});
test('status reads have a persistent cap independent of the fourteen paid calls',async()=>{
 let reads=0;const x=make({liveEnabled:true,configured:true,dayBudgetCents:100,jobBudgetCents:10,runner:async(task,ctx)=>{for(let n=0;n<172;n++){ctx.guard('read');reads++;}}});
 try{const a=x.tutor.create({text:'求二加二'},'a','1');await x.tutor.run(a.id);assert.equal(reads,171);assert.equal(x.tutor.get(a.id,'a').error,'CALL_LIMIT');const row=x.tutor.db.prepare('SELECT calls,requests FROM tasks WHERE id=?').get(a.id);assert.equal(row.calls,0);assert.equal(row.requests,171);x.tutor.close();x.tutor=new mod.Tutor({dataDir:x.dir,autoRun:false});assert.equal(x.tutor.db.prepare('SELECT requests FROM tasks WHERE id=?').get(a.id).requests,171);}finally{x.done();}
});
