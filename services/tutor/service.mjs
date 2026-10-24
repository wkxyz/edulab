import {randomUUID,randomBytes} from 'node:crypto';
import {openStore} from './store.mjs';
import {validateInput,TutorError,fail} from './validation.mjs';

const knownErrors=new Set(['STOPPED','CANCELLED','EXPIRED','TIMEOUT','NOT_CONFIGURED','REVIEW_FAILED','INVALID_LESSON','UNSUPPORTED_ANIMATION','LESSON_TOO_LONG','INVALID_FORMULA','RENDER_FAILED','PROVIDER_FAILED','CALL_LIMIT']);
export class Tutor {
 constructor(options={}){
  this.options={dailyLimit:20,ownerLimit:5,totalLimit:200,queueLimit:10,maxMs:300000,autoRun:true,liveEnabled:false,dayBudgetCents:0,jobBudgetCents:0,...options};
  this.db=openStore(options.dataDir);this.running=new Map();this.closed=false;this.draining=false;
  this.runner=options.runner||(async()=>fail('NOT_CONFIGURED',503));
 }
 isStopped(){return this.db.prepare("SELECT value FROM settings WHERE key='stopped'").get().value==='1';}
 setStopped(value){this.db.prepare("UPDATE settings SET value=? WHERE key='stopped'").run(value?'1':'0');if(value){for(const controller of this.running.values())controller.abort();}else if(this.options.autoRun)this.wake();}
 create(raw,owner,idem){
  if(!/^[a-zA-Z0-9_-]{1,128}$/.test(owner||''))fail('INVALID_SESSION',401);
  if(!/^[a-zA-Z0-9_-]{1,128}$/.test(idem||''))fail('INVALID_IDEMPOTENCY');
  if(this.isStopped())fail('STOPPED',503);
  const input=validateInput(raw),json=JSON.stringify(input);
  const old=this.db.prepare('SELECT * FROM tasks WHERE owner=? AND idem=?').get(owner,idem);
  if(old){if(old.input!==json)fail('IDEMPOTENCY_CONFLICT',409);return this.public(old);}
  const mode=input.sampleId?'sample':'live';
  const o=this.options;
  if(mode==='live'&&(!o.liveEnabled||!o.configured||o.dayBudgetCents<=0||o.jobBudgetCents<=0))fail('NOT_CONFIGURED',503);
  const now=Date.now(),day=new Date(now).toISOString().slice(0,10),reserve=mode==='live'?o.jobBudgetCents:0;
  this.db.exec('BEGIN IMMEDIATE');
  try{
   if(this.isStopped())fail('STOPPED',503);
   if(this.db.prepare('SELECT count(*) n FROM tasks').get().n>=o.totalLimit)fail('TOTAL_LIMIT',429);
   if(this.db.prepare("SELECT count(*) n FROM tasks WHERE status IN ('queued','running')").get().n>=o.queueLimit)fail('QUEUE_FULL',429);
   const usage=this.db.prepare('SELECT * FROM daily WHERE day=?').get(day);
   if((usage?.jobs||0)>=o.dailyLimit)fail('PROJECT_LIMIT',429);
   if(reserve&&(usage?.cost||0)+reserve>o.dayBudgetCents)fail('BUDGET_EXHAUSTED',429);
   const own=this.db.prepare('SELECT jobs FROM owner_daily WHERE owner=? AND day=?').get(owner,day);
   if((own?.jobs||0)>=o.ownerLimit)fail('OWNER_LIMIT',429);
   const id=randomUUID(),media=randomBytes(24).toString('hex');
   this.db.prepare("INSERT INTO tasks(id,owner,idem,input,mode,status,stage,created,expires,reserve,media_token) VALUES(?,?,?,?,?,'queued','queued',?,?,?,?)").run(id,owner,idem,json,mode,now,now+o.maxMs,reserve,media);
   this.db.prepare('INSERT INTO daily VALUES(?,1,?,?) ON CONFLICT(day) DO UPDATE SET jobs=jobs+1,calls=calls+excluded.calls,cost=cost+excluded.cost').run(day,mode==='live'?14:0,reserve);
   this.db.prepare('INSERT INTO owner_daily VALUES(?,?,1) ON CONFLICT(owner,day) DO UPDATE SET jobs=jobs+1').run(owner,day);
   this.db.exec('COMMIT');if(o.autoRun)this.wake();return this.get(id,owner);
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 public(row){
  if(!row)return null;const input=JSON.parse(row.input),result=row.result?JSON.parse(row.result):null;
  return {id:row.id,status:row.status,stage:row.stage,mode:row.mode,created:row.created,expires:row.expires,error:row.error,title:result?.title|| (input.sampleId?'一元一次方程':input.text?.slice(0,30)||'图片题目'),result:result?{...result,video:`/api/media/${row.id}/video.mp4?token=${row.media_token}`,cover:`/api/media/${row.id}/cover.png?token=${row.media_token}`} : null};
 }
 get(id,owner){return this.public(this.db.prepare('SELECT * FROM tasks WHERE id=? AND owner=?').get(id,owner));}
 list(owner){return this.db.prepare('SELECT * FROM tasks WHERE owner=? ORDER BY created DESC LIMIT 50').all(owner).map(r=>this.public(r));}
 cancel(id,owner){
  const row=this.db.prepare('SELECT status FROM tasks WHERE id=? AND owner=?').get(id,owner);if(!row)fail('NOT_FOUND',404);
  if(['queued','running'].includes(row.status)){this.db.prepare("UPDATE tasks SET status='cancelled',stage='cancelled',error='CANCELLED' WHERE id=?").run(id);this.running.get(id)?.abort();}
  return this.get(id,owner);
 }
 wake(){if(this.closed||this.wakePending)return;this.wakePending=true;queueMicrotask(()=>{this.wakePending=false;if(!this.closed)this.drain().catch(()=>{});});}
 async drain(){
  if(this.draining||this.closed||this.running.size)return;this.draining=true;
  try{for(let n=0;n<this.options.queueLimit;n++){
   if(this.closed||this.isStopped())break;
   const row=this.db.prepare("SELECT id FROM tasks WHERE status='queued' ORDER BY created LIMIT 1").get();if(!row)break;
   await this.run(row.id);
  }}finally{
   this.draining=false;
   // Only schedule existing admitted work, bounded by persistent project/queue/attempt limits.
   if(!this.closed&&!this.isStopped()&&!this.running.size&&this.db.prepare("SELECT 1 FROM tasks WHERE status='queued' LIMIT 1").get())this.wake();
  }
 }
 async run(id){
  if(this.closed||this.isStopped()||this.running.size)return;
  const row=this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  if(!row||row.status!=='queued')return;
  if(Date.now()>row.expires){this.db.prepare("UPDATE tasks SET status='failed',stage='failed',error='EXPIRED' WHERE id=?").run(id);return;}
  const claim=this.db.prepare("UPDATE tasks SET status='running',stage='recognizing',attempts=attempts+1 WHERE id=? AND status='queued' AND attempts=0").run(id);if(!claim.changes)return;
  const controller=new AbortController();this.running.set(id,controller);
  const timer=setTimeout(()=>controller.abort(new TutorError('TIMEOUT')),Math.max(1,row.expires-Date.now()));timer.unref();
  const guard=(external=false)=>{
   if(this.closed||controller.signal.aborted||this.isStopped())fail(controller.signal.reason?.code==='TIMEOUT'?'TIMEOUT':'CANCELLED');
   const current=this.db.prepare('SELECT status,calls,requests,expires FROM tasks WHERE id=?').get(id);
   if(!current||current.status!=='running')fail('CANCELLED');
   if(Date.now()>current.expires)fail('EXPIRED');
   if(external){const paid=external===true;if((!paid&&external!=='read')||row.mode!=='live'||current.requests>=171||(paid&&current.calls>=14))fail('CALL_LIMIT');this.db.prepare('UPDATE tasks SET requests=requests+1,calls=calls+? WHERE id=?').run(paid?1:0,id);}
  };
  try{
   const result=await this.runner({...row,input:JSON.parse(row.input)},{signal:controller.signal,guard,stage:(s)=>{guard();if(!['recognizing','solving','checking','voicing','rendering'].includes(s))fail('INVALID_STAGE');this.db.prepare('UPDATE tasks SET stage=? WHERE id=?').run(s);}});
   guard();this.db.prepare("UPDATE tasks SET status='completed',stage='completed',result=? WHERE id=? AND status='running'").run(JSON.stringify(result||{}),id);
  }catch(e){
   const current=this.db.prepare('SELECT status FROM tasks WHERE id=?').get(id);
   if(current?.status==='running'){
    const code=knownErrors.has(e.code)?e.code:controller.signal.aborted?'CANCELLED':'GENERATION_FAILED';
    this.db.prepare('UPDATE tasks SET status=?,stage=?,error=? WHERE id=?').run(code==='CANCELLED'?'cancelled':'failed',code==='CANCELLED'?'cancelled':'failed',code,id);
   }
  }finally{clearTimeout(timer);this.running.delete(id);if(this.closed)this.db.close();else if(this.options.autoRun&&!this.draining)this.wake();}
 }
 close(){if(this.closed)return;this.closed=true;for(const controller of this.running.values())controller.abort();if(!this.running.size)this.db.close();}
}
