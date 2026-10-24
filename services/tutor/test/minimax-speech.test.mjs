import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {configFromEnv} from '../config.mjs';
const {minimaxSpeech}=await import('../minimax.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const env={AI_PROVIDER:'minimax',MINIMAX_API_KEY:'language-test-only',MINIMAX_TTS_API_KEY:'voice-test-only'};
const context=()=>({paid:0,signal:new AbortController().signal,guard(paid){if(paid===true)this.paid++;}});
async function fixture(fn,run){const original=globalThis.fetch;globalThis.fetch=fn;try{return await run();}finally{globalThis.fetch=original;}}
const wave=()=>{const b=Buffer.alloc(48);b.write('RIFF');b.write('WAVE',8);return b;};
test('MiniMax speech uses its separate key and produces a bounded WAV without polling',async()=>{
 assert.equal(typeof minimaxSpeech,'function');
 const c=configFromEnv(env);assert.equal(c.ttsProvider,'minimax');assert.equal(c.aiKey,'language-test-only');assert.equal(c.ttsKey,'voice-test-only');assert.equal(c.ttsBase,'https://api.minimax.cn/v1');assert.equal(c.ttsModel,'speech-2.8-hd');assert.equal(c.ttsVoice,'female-chengshu');assert.equal(c.configured,true);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'minimax-speech-')),file=path.join(dir,'voice.wav'),ctx=context();let calls=0;
 try{await fixture(async(url,opts)=>{calls++;assert.equal(url,'https://api.minimax.cn/v1/t2a_v2');assert.equal(opts.redirect,'error');assert.equal(opts.headers.authorization,'Bearer voice-test-only');const b=JSON.parse(opts.body);assert.equal(b.model,'speech-2.8-hd');assert.equal(b.stream,false);assert.equal(b.output_format,'hex');assert.equal(b.voice_setting.voice_id,'female-chengshu');assert.equal(b.audio_setting.format,'wav');assert.equal(b.audio_setting.sample_rate,24000);assert.equal(b.text,'两边同时减去三。');return Response.json({base_resp:{status_code:0},data:{status:2,audio:wave().toString('hex')}});},()=>minimaxSpeech('两边同时减去三。',file,c,ctx));assert.deepEqual(fs.readFileSync(file),wave());assert.equal(calls,1);assert.equal(ctx.paid,1);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('MiniMax speech rejects business errors, unfinished audio and corrupt encodings without retries',async()=>{
 assert.equal(typeof minimaxSpeech,'function');
 const results=[{base_resp:{status_code:1004,status_msg:'private provider details'}},{base_resp:{status_code:0},data:{status:1,audio:wave().toString('hex')}},{base_resp:{status_code:0},data:{status:2,audio:'not-hex'}},{base_resp:{status_code:0},data:{status:2,audio:'00'}}];
 for(const result of results){let calls=0;await fixture(async()=>{calls++;return Response.json(result);},()=>assert.rejects(()=>minimaxSpeech('测试','/unused',configFromEnv(env),context()),e=>e.code==='PROVIDER_FAILED'&&e.message==='PROVIDER_FAILED'));assert.equal(calls,1);}
});
test('invalid MiniMax narration is rejected before consuming a paid call',async()=>{
 assert.equal(typeof minimaxSpeech,'function');
 for(const text of ['', '字'.repeat(161)]){let calls=0;const ctx=context();await fixture(async()=>{calls++;throw new Error('No request expected');},()=>assert.rejects(()=>minimaxSpeech(text,'/unused',configFromEnv(env),ctx),/INVALID_LESSON/));assert.equal(calls,0);assert.equal(ctx.paid,0);}
});
