// Protocol integration with fake KIE responses and real media rendering. Never sends paid requests.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {setTimeout as delay} from 'node:timers/promises';
import {startServer} from '../server.mjs';import {configFromEnv} from '../config.mjs';import {sampleLesson} from '../sample.mjs';
export async function verifyKieFlow(root,sourceTask,{provider='kie',acceptance=false}={}){
 const minimax=provider==='minimax';
 const original=globalThis.fetch;let chats=0,voices=0,uploads=0,downloads=0,queries=0;let app;
 const clips=sampleLesson.intro.length+sampleLesson.scenes.reduce((n,s)=>n+s.beats.length,0);
 globalThis.fetch=async(url,options={})=>{
  const value=String(url);
  if(value.startsWith('http://127.0.0.1:'))return original(url,options);
  if(value==='https://kieai.redpandaai.co/api/file-base64-upload'){uploads++;return Response.json({code:200,success:true,data:{downloadUrl:'https://tempfile.redpandaai.co/mock-question.png'}});}
  if(value==='https://api.kie.ai/gemini-3-pro/v1/chat/completions'){chats++;return Response.json({choices:[{message:{content:JSON.stringify(chats===1?sampleLesson:{correct:true})}}]});}
  if(minimax&&value==='https://api.minimax.cn/v1/chat/completions'){chats++;assert.equal(options.headers.authorization,'Bearer minimax-mock-only');return Response.json({model:'MiniMax-M3.1-Flash',base_resp:{status_code:0},choices:[{finish_reason:'stop',message:{content:JSON.stringify(chats===1?sampleLesson:{correct:true})}}]});}
  if(minimax&&value==='https://api.minimax.cn/v1/t2a_v2'){const index=voices++;assert.equal(options.headers.authorization,'Bearer voice-mock-only');return Response.json({base_resp:{status_code:0},data:{status:2,audio:fs.readFileSync(path.join(root,'jobs',sourceTask,'speech-'+index+'.wav')).toString('hex')}});}
  if(value==='https://api.kie.ai/api/v1/jobs/createTask'){const id=voices++;return Response.json({code:200,data:{taskId:'voice-'+id}});}
  if(value.startsWith('https://api.kie.ai/api/v1/jobs/recordInfo?taskId=voice-')){queries++;const index=Number(new URL(value).searchParams.get('taskId').slice(6));return Response.json({code:200,data:{state:'success',resultJson:JSON.stringify({resultUrls:[`https://tempfile.aiquickdraw.com/voice-${index}.wav`]})}});}
  const match=/^https:\/\/tempfile\.aiquickdraw\.com\/voice-(\d+)\.wav$/.exec(value);
  if(match){downloads++;assert.equal(options.headers?.authorization,undefined);return new Response(fs.readFileSync(path.join(root,'jobs',sourceTask,`speech-${match[1]}.wav`)));}
  throw new Error('Unexpected external request in mock KIE integration');
 };
 try{
  const dataDir=path.join(root,provider+'-integration'+(acceptance?'-acceptance':''));
  app=await startServer({...configFromEnv({AI_PROVIDER:provider,KIE_API_KEY:'mock-only',MINIMAX_API_KEY:'minimax-mock-only',MINIMAX_TTS_API_KEY:'voice-mock-only'}),dataDir,port:0,liveEnabled:true,dayBudgetCents:100,jobBudgetCents:10,maxMs:90000,renderOptions:{fps:6,scale:1}});
  const base=`http://127.0.0.1:${app.server.address().port}`,token=(await original(base+'/api/session',{method:'POST'}).then(r=>r.json())).token;
  let task;
  if(acceptance){
   // Exercise the exact production acceptance program against this isolated mock server.
   // Substitute only its environment and the known sample equation; no production hooks.
   const python=fs.readFileSync(new URL('./accept-minimax-once.py',import.meta.url),'utf8');
   const extracted=/FLOW = r'''([\s\S]*?)'''/.exec(python);assert.ok(extracted);
   let source=extracted[1]
    .replace("const base='http://127.0.0.1:8788',publicBase='https://pt.yokily.com';",'const base='+JSON.stringify(base)+',publicBase='+JSON.stringify(base)+';')
    .replaceAll('3x - 7 = 8','2x + 3 = 11').replaceAll('3x-7=8','2x+3=11')
    .replace('x=5(?!','x=4(?!')
    .replace("path.join('/data/jobs',",'path.join('+JSON.stringify(path.join(dataDir,'jobs'))+',')
    .replace("location.hostname==='pt.yokily.com'","location.hostname==='127.0.0.1'")
    .replace("import('playwright')",'import('+JSON.stringify(import.meta.resolve('playwright'))+')')
    .replace('console.log(JSON.stringify(out));','export default out;');
   const report=(await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).default;
   assert.equal(report.status,'passed',JSON.stringify(report));assert.equal(report.submissionAttempts,1);
   assert.equal(report.audioNonSilent,true);assert.equal(report.httpRange,206);assert.equal(report.consoleErrors,0);
   const owner=app.tutor.db.prepare('SELECT owner FROM tasks WHERE id=?').get(report.taskId).owner;
   task=app.tutor.get(report.taskId,owner);
   console.log('MOCK_ACCEPTANCE_RESULT',JSON.stringify({status:report.status,submissions:report.submissionAttempts,audioNonSilent:report.audioNonSilent,playback:report.playback,httpRange:report.httpRange,realPaidCalls:0}));
  }else{
   const response=await original(base+'/api/tasks',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':'kie-flow'},body:JSON.stringify({style:'chalk',image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XKqkAAAAASUVORK5CYII='})});assert.equal(response.status,202);
   task=await response.json();for(let i=0;i<90&&['queued','running'].includes(task.status);i++){await delay(1000);task=app.tutor.get(task.id,token);}
  }
  assert.equal(task.status,'completed',task.error);assert.equal(task.mode,'live');assert.equal(task.result.answer,'x = 4');
  assert.equal(chats,2);assert.equal(voices,clips);assert.equal(uploads,minimax?0:1);assert.equal(queries,minimax?0:clips);assert.equal(downloads,minimax?0:clips);
  const counters=app.tutor.db.prepare('SELECT calls,requests FROM tasks WHERE id=?').get(task.id);assert.equal(counters.calls,2+clips);assert.equal(counters.requests,minimax?2+clips:3+clips*3);
  const media=await original(base+task.result.video,{headers:{range:'bytes=0-1023'}});assert.equal(media.status,206);assert.equal((await media.arrayBuffer()).byteLength,1024);
  console.log(minimax?'MOCK_MINIMAX_RESULT':'MOCK_KIE_RESULT',JSON.stringify({status:task.status,answer:task.result.answer,uploads,chats,voices,queries,downloads,...counters,realPaidCalls:0}));
 }finally{if(app){await new Promise(r=>app.server.close(r));app.tutor.close();}globalThis.fetch=original;}
}
