import test from 'node:test';import assert from 'node:assert/strict';
import {configFromEnv} from '../config.mjs';import {solve} from '../ai.mjs';import {sampleLesson} from '../sample.mjs';
const env={AI_PROVIDER:'minimax',MINIMAX_API_KEY:'minimax-test-only',KIE_API_KEY:'kie-test-only'};
const context=()=>({signal:new AbortController().signal,stage(){},guard(){}});
async function fixture(fn,run){const original=globalThis.fetch;globalThis.fetch=fn;try{return await run();}finally{globalThis.fetch=original;}}
test('MiniMax config separates language and speech credentials with an optional KIE override',()=>{
 const c=configFromEnv(env);assert.equal(c.provider,'minimax');assert.equal(c.aiModel,'MiniMax-M3.1-Flash');assert.equal(c.aiKey,'minimax-test-only');assert.equal(c.aiBase,'https://api.minimax.cn/v1');assert.equal(c.reasoningEffort,'medium');assert.equal(c.ttsKey,'minimax-test-only');assert.equal(c.ttsProvider,'minimax');assert.equal(c.configured,true);assert.equal(c.liveEnabled,false);
 assert.equal(configFromEnv({...env,MINIMAX_API_KEY:''}).configured,false);
 assert.equal(configFromEnv({...env,KIE_API_KEY:''}).configured,true);
 assert.equal(configFromEnv({...env,MINIMAX_TTS_API_KEY:'separate-voice'}).ttsKey,'separate-voice');
 assert.equal(configFromEnv({...env,TTS_PROVIDER:'kie'}).ttsKey,'kie-test-only');
 assert.equal(configFromEnv({...env,MINIMAX_TTS_REGION:'global'}).ttsBase,'https://api.minimax.io/v1');
 assert.throws(()=>configFromEnv({...env,TTS_PROVIDER:'invalid'}),/TTS_PROVIDER/);
 assert.throws(()=>configFromEnv({...env,MINIMAX_TTS_MODEL:'unknown'}),/MINIMAX_TTS_MODEL/);
 assert.equal(configFromEnv({...env,MINIMAX_REGION:'global'}).aiBase,'https://api.minimax.io/v1');
 assert.throws(()=>configFromEnv({...env,MINIMAX_REGION:'invalid'}),/MINIMAX_REGION/);
 assert.throws(()=>configFromEnv({...env,MINIMAX_REASONING_EFFORT:'none'}),/MINIMAX_REASONING_EFFORT/);
});
test('MiniMax sees the original image twice without uploading it or forwarding KIE credentials',async()=>{
 const requests=[],image='data:image/png;base64,iVBORw0KGgo=';
 await fixture(async(url,opts)=>{const b=JSON.parse(opts.body);requests.push({url,opts,b});return Response.json({model:'MiniMax-M3.1-Flash',base_resp:{status_code:0},choices:[{finish_reason:'stop',message:{content:JSON.stringify(requests.length===1?sampleLesson:{correct:true}),reasoning_content:'private reasoning'}}]});},()=>solve({image,text:'请解原图题目',style:'chalk'},configFromEnv(env),context()));
 assert.equal(requests.length,2);
 for(const r of requests){assert.equal(r.url,'https://api.minimax.cn/v1/chat/completions');assert.equal(r.opts.headers.authorization,'Bearer minimax-test-only');assert.equal(r.opts.redirect,'error');assert.equal(r.b.model,'MiniMax-M3.1-Flash');assert.equal(r.b.reasoning_effort,'medium');assert.equal(r.b.reasoning_split,true);assert.equal(r.b.response_format,undefined);assert.equal(r.b.max_tokens,undefined);assert.match(JSON.stringify(r.b.messages),/data:image\/png/);assert.doesNotMatch(JSON.stringify(r.b),/private reasoning|kie-test-only/);}
 assert.equal(requests[0].b.max_completion_tokens,8192);assert.equal(requests[1].b.max_completion_tokens,4096);
});
test('MiniMax application errors, truncated responses and wrong models never reach narration or retry',async()=>{
 for(const result of [{base_resp:{status_code:1004,status_msg:'private key detail'}},{model:'MiniMax-M3.1-Flash',choices:[{finish_reason:'length',message:{content:JSON.stringify(sampleLesson)}}]},{model:'different-model',choices:[{finish_reason:'stop',message:{content:JSON.stringify(sampleLesson)}}]}]){
  let calls=0;await fixture(async()=>{calls++;return Response.json(result);},()=>assert.rejects(()=>solve({text:'解方程',style:'chalk'},configFromEnv(env),context()),e=>['PROVIDER_FAILED','INVALID_LESSON'].includes(e.code)&&!e.message.includes('private')));assert.equal(calls,1);
 }
});
