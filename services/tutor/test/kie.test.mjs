import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {configFromEnv} from '../config.mjs';import {kieSpeech,uploadQuestion} from '../kie.mjs';import {solve} from '../ai.mjs';import {sampleLesson} from '../sample.mjs';
const config=()=>configFromEnv({AI_PROVIDER:'kie',KIE_API_KEY:'test-only'});
const context=()=>{const controller=new AbortController(),counts={paid:0,read:0};return {controller,counts,signal:controller.signal,stage(){},guard(kind){controller.signal.throwIfAborted();if(kind===true)counts.paid++;if(kind==='read')counts.read++;}};};
const fixture=async(fn,work)=>{const original=globalThis.fetch;globalThis.fetch=fn;try{return await work();}finally{globalThis.fetch=original;}};
test('live trial cap accepts an explicit stop or one task and rejects invalid limits',()=>{
 assert.equal(configFromEnv({LIVE_TASK_LIMIT:'0'}).liveTaskLimit,0);
 assert.equal(configFromEnv({LIVE_TASK_LIMIT:'1'}).liveTaskLimit,1);
 for(const value of ['-1','1.5','201','NaN'])assert.throws(()=>configFromEnv({LIVE_TASK_LIMIT:value}),/Invalid configuration: LIVE_TASK_LIMIT/);
});
test('one KIE key configures both providers without a GLM key',()=>{
 const c=config();assert.equal(c.configured,true);assert.equal(c.aiKey,'test-only');assert.equal(c.ttsKey,'test-only');assert.equal(c.aiBase,'https://api.kie.ai/gemini-3-pro/v1');assert.equal(c.ttsProvider,'kie');assert.equal(c.liveEnabled,false);
 assert.equal(configFromEnv({AI_PROVIDER:'kie',GLM_API_KEY:'unrelated'}).configured,false);
});
test('KIE image upload is reused by solving and original-question review',async()=>{
 const requests=[],ctx=context();let chats=0;
 await fixture(async(url,opts)=>{requests.push({url,body:JSON.parse(opts.body),auth:opts.headers.authorization});
  if(url.includes('file-base64-upload'))return Response.json({code:200,success:true,data:{downloadUrl:'https://tempfile.redpandaai.co/random/question.png'}});
  chats++;return Response.json({choices:[{message:{content:JSON.stringify(chats===1?sampleLesson:{correct:true})}}]});
 },async()=>{await solve({image:'data:image/png;base64,iVBORw0KGgo=',style:'chalk'},config(),ctx);});
 assert.equal(requests.length,3);assert.equal(ctx.counts.paid,2);assert.equal(ctx.counts.read,1);
 for(const r of requests.slice(1)){assert.equal(r.auth,'Bearer test-only');assert.equal(r.body.stream,false);assert.match(JSON.stringify(r.body.messages),/https:\/\/tempfile.redpandaai.co\/random\/question.png/);assert.doesNotMatch(JSON.stringify(r.body.messages),/data:image/);}
 assert.equal(requests[1].body.max_tokens,2400);assert.equal(requests[2].body.max_tokens,640);
});
test('KIE speech creates once, polls to success and downloads audio without credentials',async()=>{
 const ctx=context(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'kie-test-')),file=path.join(dir,'speech.wav');let polls=0,creates=0;
 try{await fixture(async(url,opts={})=>{
  if(url.endsWith('/createTask')){creates++;const b=JSON.parse(opts.body);assert.equal(b.model,'elevenlabs/text-to-speech-multilingual-v2');assert.equal(b.input.text,'两边同时减去三。');assert.equal(b.input.language_code,undefined);return Response.json({code:200,data:{taskId:'task_test'}});}
  if(url.includes('/recordInfo')){polls++;return Response.json({code:200,data:{state:polls===1?'generating':'success',resultJson:JSON.stringify({resultUrls:['https://tempfile.aiquickdraw.com/audio.mp3']})}});}
  assert.equal(opts.headers?.authorization,undefined);return new Response(Buffer.from('ID3test-audio'));
 },()=>kieSpeech('两边同时减去三。',file,config(),ctx,{wait:async()=>{}}));assert.equal(creates,1);assert.equal(polls,2);assert.equal(ctx.counts.paid,1);assert.equal(fs.readFileSync(file).toString(),'ID3test-audio');}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('KIE HTTP-200 application errors are terminal without paid retries',async()=>{
 const ctx=context();let n=0;await fixture(async()=>{n++;return Response.json({code:401,msg:'private provider error'});},()=>assert.rejects(()=>kieSpeech('测试','/unused',config(),ctx,{wait:async()=>{}}),/PROVIDER_FAILED/));assert.equal(n,1);
});
test('KIE pending speech ends after twelve queries and never resubmits',async()=>{
 const ctx=context();let creates=0,polls=0;
 await fixture(async url=>{if(url.endsWith('/createTask')){creates++;return Response.json({code:200,data:{taskId:'task_test'}});}polls++;return Response.json({code:200,data:{state:'generating'}});},()=>assert.rejects(()=>kieSpeech('测试','/unused',config(),ctx,{wait:async()=>{}}),/TIMEOUT/));assert.equal(creates,1);assert.equal(polls,12);
});
test('KIE stop during a poll interval prevents subsequent queries',async()=>{
 const ctx=context();let n=0;await fixture(async()=>{n++;return Response.json({code:200,data:{taskId:'task_test'}});},()=>assert.rejects(()=>kieSpeech('测试','/unused',config(),ctx,{wait:async()=>{ctx.controller.abort(new Error('cancelled'));}}),/cancelled/));assert.equal(n,1);
});
test('KIE never downloads local, redirected or unexpected result URLs',async()=>{
 for(const url of ['http://127.0.0.1/a','https://evil.example/a','https://tempfile.aiquickdraw.com:8443/a']){
  let n=0;await fixture(async()=>{n++;return Response.json(n===1?{code:200,data:{taskId:'task_test'}}:{code:200,data:{state:'success',resultJson:JSON.stringify({resultUrls:[url]})}});},()=>assert.rejects(()=>kieSpeech('测试','/unused',config(),context(),{wait:async()=>{}}),/PROVIDER_FAILED/));assert.equal(n,2);
 }
});
test('KIE chat rejects an application error even when HTTP and choices look successful',async()=>{
 let calls=0;await fixture(async()=>{calls++;return Response.json({code:500,choices:[{message:{content:JSON.stringify(sampleLesson)}}]});},()=>assert.rejects(()=>solve({text:'解方程',style:'chalk'},config(),context()),/PROVIDER_FAILED/));assert.equal(calls,1);
});
test('KIE upstream timeouts keep a safe timeout code and never resubmit',async()=>{
 for(const response of [()=>Response.json({code:524,msg:'2 times retry fail'}),()=>new Response('upstream private details',{status:524})]){
  let calls=0;
  await fixture(async()=>{calls++;return response();},()=>assert.rejects(()=>solve({text:'解方程',style:'chalk'},config(),context()),error=>error.code==='PROVIDER_TIMEOUT'&&error.message==='PROVIDER_TIMEOUT'));
  assert.equal(calls,1);
 }
});
test('KIE audio download rejects redirect and over-limit responses',async()=>{
 for(const response of [()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/private'}}),()=>new Response(Buffer.alloc(12*1024*1024+1))]){
  let calls=0;await fixture(async(url,opts)=>{calls++;if(calls===1)return Response.json({code:200,data:{taskId:'task_test'}});if(calls===2)return Response.json({code:200,data:{state:'success',resultJson:JSON.stringify({resultUrls:['https://tempfile.aiquickdraw.com/audio.mp3']})}});assert.equal(opts.redirect,'error');assert.equal(opts.headers?.authorization,undefined);return response();},()=>assert.rejects(()=>kieSpeech('测试','/unused',config(),context(),{wait:async()=>{}}),/PROVIDER_FAILED/));assert.equal(calls,3);
 }
});
