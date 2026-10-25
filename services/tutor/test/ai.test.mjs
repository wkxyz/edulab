import test from 'node:test';import assert from 'node:assert/strict';import {solve} from '../ai.mjs';import {sampleLesson} from '../sample.mjs';
test('independent review sees the original text and catches a rewritten question',async()=>{
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async(url,opts)=>{const data=JSON.parse(opts.body);calls++;let result;
  if(calls===1)result=sampleLesson;
  else result={correct:!JSON.stringify(data.messages).includes('解方程：2x + 3 = 13')};
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}),{status:200,headers:{'content-type':'application/json'}});
 };
 try{await assert.rejects(()=>solve({text:'解方程：2x + 3 = 13',style:'chalk'},{aiBase:'https://provider.invalid/v1',aiKey:'test-only',aiModel:'test'},{guard(){},stage(){},signal:new AbortController().signal}),/REVIEW_FAILED/);}finally{globalThis.fetch=original;}
});
