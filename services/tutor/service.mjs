import {randomUUID,randomBytes} from 'node:crypto';
import {openStore} from './store.mjs';
import {validateInput,TutorError,fail} from './validation.mjs';
import {getCapability} from '../../apps/web/capabilities.mjs';

const knownErrors=new Set(['STOPPED','CANCELLED','EXPIRED','TIMEOUT','NOT_CONFIGURED','REVIEW_FAILED','INVALID_LESSON','UNSUPPORTED_ANIMATION','UNSUPPORTED_PROBLEM','INVALID_INTERACTIVE_SPEC','INTERACTIVE_DEPENDENCY_MISSING','INTERACTIVE_RENDER_FAILED','INVALID_ANIMATION','UNBALANCED_EQUATION','UNBALANCED_ELECTRONS','ARTIFACT_EXPIRED','EXPORT_NOT_AVAILABLE','NARRATION_NOT_AVAILABLE','LESSON_TOO_LONG','INVALID_FORMULA','RENDER_FAILED','PROVIDER_FAILED','PROVIDER_TIMEOUT','CALL_LIMIT']);
const paidTask=(mode,input)=>mode==='live'||mode==='narration'&&input.sourceMode==='live';
const voiced=result=>result.audioReady===true||result.audioReady!==false&&(result.format==='video'||result.videoReady===true||!!result.video);
const narrationCapability=id=>['solid-geometry','analytic-geometry'].includes(id)?'math-video':id==='chem-reaction'?'chem-video':id;
export class Tutor {
 constructor(options={}){
  this.options={dailyLimit:20,ownerLimit:5,sampleOwnerLimit:options.ownerLimit??20,totalLimit:200,liveTaskLimit:200,queueLimit:10,maxMs:300000,autoRun:true,liveEnabled:false,dayBudgetCents:0,jobBudgetCents:0,stageQuota:false,projectBudgetCents:2000,lessonBudgetCents:100,narrationBudgetCents:200,lessonTaskLimit:0,narrationTaskLimit:0,lessonDailyLimit:20,narrationDailyLimit:20,...options};
  if(!Number.isSafeInteger(this.options.projectBudgetCents)||this.options.projectBudgetCents<0||this.options.projectBudgetCents>2000)throw new Error('Invalid configuration: projectBudgetCents');
  this.db=openStore(options.dataDir);this.running=new Map();this.closed=false;this.draining=false;
  this.runner=options.runner||(async()=>fail('NOT_CONFIGURED',503));
 }
 isStopped(){return this.db.prepare("SELECT value FROM settings WHERE key='stopped'").get().value==='1';}
 liveLimitReached(){return this.db.prepare("SELECT count(*) n FROM tasks WHERE mode='live'").get().n>=this.options.liveTaskLimit;}
 budget(){
  const limitCents=this.options.projectBudgetCents,reservedCents=this.db.prepare('SELECT coalesce(sum(reserve),0) n FROM tasks').get().n;
  return {currency:'CNY',kind:'cumulative-reservation',limitCents,reservedCents,remainingCents:Math.max(0,limitCents-reservedCents)};
 }
 stageUsage(stage,day=null,owner=null){
  let count=0;const start=day?Date.parse(day+'T00:00:00Z'):0;
  for(const row of this.db.prepare("SELECT mode,input,status,result,created,owner FROM tasks WHERE mode IN ('live','narration')").all()){
   if(day&&(row.created<start||row.created>=start+86400000)||owner&&row.owner!==owner)continue;
   const input=JSON.parse(row.input);
   if(stage==='lesson'&&row.mode==='live')count++;
   if(stage==='narration'&&(row.mode==='narration'&&input.sourceMode==='live'||row.mode==='live'&&(input.delivery==='video'||input.delivery===undefined&&row.status==='completed'&&row.result&&voiced(JSON.parse(row.result)))))count++;
  }
  return count;
 }
 freeUsage(day,owner=null){
  const start=Date.parse(day+'T00:00:00Z');
  return this.db.prepare('SELECT mode,input,owner FROM tasks WHERE created>=? AND created<?').all(start,start+86400000).filter(row=>(!owner||row.owner===owner)&&!paidTask(row.mode,JSON.parse(row.input))).length;
 }
 stageAvailability(stage){
  const o=this.options,reserveCents=o.stageQuota?(stage==='lesson'?o.lessonBudgetCents:o.narrationBudgetCents):stage==='lesson'?o.jobBudgetCents:o.narrationBudgetCents;
  let reason=null;const day=new Date().toISOString().slice(0,10);
  if(this.isStopped())reason='STOPPED';
  else if(!o.liveEnabled||!(stage==='lesson'?(o.lessonConfigured??o.configured):(o.narrationConfigured??o.configured))||reserveCents<=0||!o.stageQuota&&o.dayBudgetCents<=0)reason='NOT_CONFIGURED';
  else if(o.stageQuota&&this.stageUsage(stage)>=(stage==='lesson'?o.lessonTaskLimit:o.narrationTaskLimit))reason=stage==='lesson'?'LESSON_LIMIT':'NARRATION_LIMIT';
  else if(o.stageQuota&&this.stageUsage(stage,day)>=(stage==='lesson'?o.lessonDailyLimit:o.narrationDailyLimit))reason=stage==='lesson'?'LESSON_DAILY_LIMIT':'NARRATION_DAILY_LIMIT';
  else if(!o.stageQuota&&this.liveLimitReached())reason='LIVE_LIMIT';
  else if(this.budget().reservedCents+reserveCents>o.projectBudgetCents)reason='PROJECT_BUDGET_EXHAUSTED';
  else {
   const usage=this.db.prepare('SELECT * FROM daily WHERE day=?').get(day);
   if(o.dayBudgetCents>0&&(usage?.cost||0)+reserveCents>o.dayBudgetCents)reason='BUDGET_EXHAUSTED';
   else if(this.db.prepare('SELECT count(*) n FROM tasks').get().n>=o.totalLimit)reason='TOTAL_LIMIT';
   else if(this.db.prepare("SELECT count(*) n FROM tasks WHERE status IN ('queued','running')").get().n>=o.queueLimit)reason='QUEUE_FULL';
   else if(!o.stageQuota&&(usage?.jobs||0)>=o.dailyLimit)reason='PROJECT_LIMIT';
  }
  return {available:reason===null,reason,reserveCents};
 }
 health(){
  const lesson=this.stageAvailability('lesson'),narration=this.stageAvailability('narration');
  return {liveEnabled:lesson.available,liveLimitReached:!this.options.stageQuota&&this.liveLimitReached(),stopped:this.isStopped(),stages:{lesson,narration},budget:this.budget()};
 }
 setStopped(value){this.db.prepare("UPDATE settings SET value=? WHERE key='stopped'").run(value?'1':'0');if(value){for(const controller of this.running.values())controller.abort();}else if(this.options.autoRun)this.wake();}
 create(raw,owner,idem,exportSource=null,narrationSource=null){
  if(!/^[a-zA-Z0-9_-]{1,128}$/.test(owner||''))fail('INVALID_SESSION',401);
  if(!/^[a-zA-Z0-9_-]{1,128}$/.test(idem||''))fail('INVALID_IDEMPOTENCY');
  const validated=exportSource||narrationSource?null:validateInput(raw),o=this.options;
  let admitted;
  this.db.exec('BEGIN IMMEDIATE');
  try{
   if(this.isStopped())fail('STOPPED',503);
   let input=validated,source;
   if(exportSource||narrationSource){
    source=this.db.prepare('SELECT * FROM tasks WHERE id=? AND owner=?').get(exportSource||narrationSource,owner);
    if(!source)fail('NOT_FOUND',404);
    const unavailable=exportSource?'EXPORT_NOT_AVAILABLE':'NARRATION_NOT_AVAILABLE';
    if(source.status!=='completed'||!source.result)fail(unavailable,409);
    const result=JSON.parse(source.result),prior=JSON.parse(source.input);
    if(narrationSource){
     if(voiced(result)){admitted=this.public(source);this.db.exec('COMMIT');return admitted;}
     if(!['lesson','interactive'].includes(result.format))fail(unavailable,409);
     input={narrationOf:source.id,sourceMode:paidTask(source.mode,prior)?'live':'sample',sourceCapability:prior.capability||'math-video',sourceResult:result,capability:narrationCapability(prior.capability||'math-video'),style:prior.style||'whiteboard',delivery:'video',exportVideo:false};
    }else{
     if(['lesson','interactive'].includes(result.format)||!voiced(result))fail(unavailable,409);
     if(result.videoReady!==false){admitted=this.public(source);this.db.exec('COMMIT');return admitted;}
     input={exportOf:source.id,capability:prior.capability||'math-video',style:prior.style||'whiteboard',sourceResult:result,sourceMode:paidTask(source.mode,prior)?'live':prior.sourceMode||'sample',...(prior.narrationOf?{narrationOf:prior.narrationOf}:{}),delivery:'video',exportVideo:true};
    }
   }
   const json=JSON.stringify(input),old=this.db.prepare('SELECT * FROM tasks WHERE owner=? AND idem=?').get(owner,idem);
   if(old){
    let matches=old.input===json;
    if(exportSource&&old.mode==='export'){
     const prior=JSON.parse(old.input);
     matches=prior.exportOf===input.exportOf&&(prior.capability||'math-video')===input.capability&&(prior.style||'whiteboard')===input.style&&JSON.stringify(prior.sourceResult)===JSON.stringify(input.sourceResult);
    }
    if(!exportSource&&!narrationSource){
     const prior=JSON.parse(old.input);
     matches=JSON.stringify(validateInput(prior))===json;
     // Older video tasks predate delivery. Normalize for comparison only; keep their stored JSON intact.
     if(!matches&&prior.delivery===undefined&&input.delivery==='video')matches=JSON.stringify(validateInput({...prior,delivery:'video'}))===json;
    }
    if(!matches)fail('IDEMPOTENCY_CONFLICT',409);
    admitted=this.public(old);this.db.exec('COMMIT');return admitted;
   }
   const mode=exportSource?'export':narrationSource?'narration':input.sampleId?'sample':'live',paid=paidTask(mode,input);
   const now=Date.now(),day=new Date(now).toISOString().slice(0,10);
   let reserve=0,stages=[];
   if(paid){
    stages=mode==='narration'?['narration']:input.delivery==='video'&&o.stageQuota?['lesson','narration']:['lesson'];
    for(const stage of stages){const availability=this.stageAvailability(stage);if(!availability.available)fail(availability.reason,availability.reason==='NOT_CONFIGURED'||availability.reason==='STOPPED'?503:429);reserve+=availability.reserveCents;}
    if(this.budget().reservedCents+reserve>o.projectBudgetCents)fail('PROJECT_BUDGET_EXHAUSTED',429);
   }
   if(this.db.prepare('SELECT count(*) n FROM tasks').get().n>=o.totalLimit)fail('TOTAL_LIMIT',429);
   if(this.db.prepare("SELECT count(*) n FROM tasks WHERE status IN ('queued','running')").get().n>=o.queueLimit)fail('QUEUE_FULL',429);
   const usage=this.db.prepare('SELECT * FROM daily WHERE day=?').get(day);
   if(o.stageQuota?!paid&&this.freeUsage(day)>=o.dailyLimit:(usage?.jobs||0)>=o.dailyLimit)fail('PROJECT_LIMIT',429);
   if(reserve&&o.dayBudgetCents>0&&(usage?.cost||0)+reserve>o.dayBudgetCents)fail('BUDGET_EXHAUSTED',429);
   const own=this.db.prepare('SELECT jobs FROM owner_daily WHERE owner=? AND day=?').get(owner,day),start=Date.parse(day+'T00:00:00Z');
   const paidOwn=paid?this.db.prepare("SELECT mode,input FROM tasks WHERE owner=? AND created>=? AND created<?").all(owner,start,start+86400000).filter(row=>paidTask(row.mode,JSON.parse(row.input))).length:0;
   const ownerReached=o.stageQuota?(paid?stages.some(stage=>this.stageUsage(stage,day,owner)>=o.ownerLimit):this.freeUsage(day,owner)>=o.sampleOwnerLimit):(paid?paidOwn>=o.ownerLimit:(own?.jobs||0)>=o.sampleOwnerLimit);
   if(ownerReached)fail('OWNER_LIMIT',429);
   const id=randomUUID(),media=randomBytes(24).toString('hex');
   this.db.prepare("INSERT INTO tasks(id,owner,idem,input,mode,status,stage,created,expires,reserve,media_token) VALUES(?,?,?,?,?,'queued','queued',?,?,?,?)").run(id,owner,idem,json,mode,now,now+o.maxMs,reserve,media);
   this.db.prepare('INSERT INTO daily VALUES(?,1,?,?) ON CONFLICT(day) DO UPDATE SET jobs=jobs+1,calls=calls+excluded.calls,cost=cost+excluded.cost').run(day,paid?14:0,reserve);
   this.db.prepare('INSERT INTO owner_daily VALUES(?,?,1) ON CONFLICT(owner,day) DO UPDATE SET jobs=jobs+1').run(owner,day);
   admitted=this.public(this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id));
   this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
  if(o.autoRun)this.wake();return admitted;
 }
 createExport(id,owner){if(!/^[a-f0-9-]{36}$/.test(id))fail('NOT_FOUND',404);return this.create(null,owner,'export_'+id,id);}
 createNarration(id,owner){if(!/^[a-f0-9-]{36}$/.test(id))fail('NOT_FOUND',404);return this.create(null,owner,'narration_'+id,null,id);}
 public(row){
  if(!row)return null;const input=JSON.parse(row.input),result=row.result?JSON.parse(row.result):null;
  const capability=input.capability||'math-video',entry=getCapability(capability);
  const url=name=>`/api/media/${row.id}/${name}?token=${row.media_token}`;
  return {id:row.id,status:row.status,stage:row.stage,mode:row.mode,capability,delivery:input.delivery||'video',...(input.exportOf||input.narrationOf?{sourceTaskId:input.exportOf||input.narrationOf}:{}),...(input.narrationOf?{narrationOf:input.narrationOf}:{}),...(input.sourceMode?{sourceMode:input.sourceMode}:{}),created:row.created,expires:row.expires,error:row.error,title:result?.title||input.sourceResult?.title||(input.sampleId?(capability==='math-video'?'一元一次方程':entry.sampleLabel):input.text?.slice(0,30)||'图片题目'),result:result?{...result,...(!['lesson','interactive'].includes(result.format)&&voiced(result)&&result.videoReady!==false?{video:url('video.mp4')}:{video:undefined}),...(result.coverReady!==false?{cover:url('cover.png')}:{}),...(result.previewReady?{preview:url('preview.html'),download:url('lesson.html')}:{}),...(result.subtitlesReady?{subtitles:url('subtitles.srt')}:{})}:null};
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
   if(external){const paid=external===true;if((!paid&&external!=='read')||!paidTask(row.mode,JSON.parse(row.input))||current.requests>=171||(paid&&current.calls>=14))fail('CALL_LIMIT');this.db.prepare('UPDATE tasks SET requests=requests+1,calls=calls+? WHERE id=?').run(paid?1:0,id);}
  };
  try{
   const result=await this.runner({...row,input:JSON.parse(row.input)},{signal:controller.signal,guard,stage:(s)=>{guard();if(!['recognizing','solving','checking','voicing','rendering'].includes(s))fail('INVALID_STAGE');this.db.prepare('UPDATE tasks SET stage=? WHERE id=?').run(s);}});
   guard();this.db.prepare("UPDATE tasks SET status='completed',stage='completed',result=? WHERE id=? AND status='running'").run(JSON.stringify(result||{}),id);
  }catch(e){
   const current=this.db.prepare('SELECT status FROM tasks WHERE id=?').get(id);
   if(current?.status==='running'){
    const code=controller.signal.reason?.code==='TIMEOUT'?'TIMEOUT':knownErrors.has(e.code)?e.code:controller.signal.aborted?'CANCELLED':'GENERATION_FAILED';
    this.db.prepare('UPDATE tasks SET status=?,stage=?,error=? WHERE id=?').run(code==='CANCELLED'?'cancelled':'failed',code==='CANCELLED'?'cancelled':'failed',code,id);
   }
  }finally{clearTimeout(timer);this.running.delete(id);if(this.closed)this.db.close();else if(this.options.autoRun&&!this.draining)this.wake();}
 }
 close(){if(this.closed)return;this.closed=true;for(const controller of this.running.values())controller.abort();if(!this.running.size)this.db.close();}
}
