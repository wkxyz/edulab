import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {Tutor} from '../service.mjs';
test('older databases gain the request counter while keeping tasks, budgets and stopped state',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tutor-migration-'));let tutor;
 try{tutor=new Tutor({dataDir:dir,autoRun:false});const task=tutor.create({sampleId:'equation'},'a','1');tutor.setStopped(true);tutor.db.exec('ALTER TABLE tasks DROP COLUMN requests');tutor.close();
  tutor=new Tutor({dataDir:dir,autoRun:false});assert.equal(tutor.isStopped(),true);assert.equal(tutor.get(task.id,'a').status,'queued');assert.equal(tutor.db.prepare('SELECT jobs FROM daily').get().jobs,1);assert.equal(tutor.db.prepare('SELECT requests FROM tasks').get().requests,0);
 }finally{tutor?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
