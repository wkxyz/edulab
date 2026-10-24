import {writeFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';import {setTimeout as delay} from 'node:timers/promises';
import {fail} from './validation.mjs';import {jsonResponse,responseBytes} from './provider-http.mjs';
const API='https://api.kie.ai/api/v1/jobs';
const UPLOAD='https://kieai.redpandaai.co/api/file-base64-upload';
const FILE_HOSTS=new Set(['tempfile.redpandaai.co','tempfile.aiquickdraw.com','file.aiquickdraw.com']);
function fileUrl(value){
 let url;try{url=new URL(value);}catch{fail('PROVIDER_FAILED',502);}
 if(url.protocol!=='https:'||url.username||url.password||url.port||!FILE_HOSTS.has(url.hostname)||url.href.length>8192)fail('PROVIDER_FAILED',502);
 return url.href;
}
async function request(url,config,ctx,{method='GET',data,paid=false}={}){
 ctx.guard(paid?true:'read');
 const response=await fetch(url,{method,redirect:'error',headers:{authorization:'Bearer '+config.ttsKey,'content-type':'application/json'},signal:AbortSignal.any([ctx.signal,AbortSignal.timeout(15000)]),...(data?{body:JSON.stringify(data)}:{})});
 const result=await jsonResponse(response);ctx.guard();return result;
}
export async function uploadQuestion(image,config,ctx){
 const ext=/^data:image\/(png|jpeg|webp);base64,/.exec(image)?.[1];if(!ext)fail('INVALID_IMAGE');
 const data=await request(UPLOAD,config,ctx,{method:'POST',data:{base64Data:image,uploadPath:'tutor/questions',fileName:randomUUID()+'.'+ext}});
 if(data.success!==true)fail('PROVIDER_FAILED',502);return fileUrl(data.data?.downloadUrl);
}
export async function kieSpeech(text,file,config,ctx,{wait=(ms,signal)=>delay(ms,undefined,{signal})}={}){
 if(typeof text!=='string'||!text.trim()||text.length>160)fail('INVALID_LESSON');
 const model=config.ttsModel||'elevenlabs/text-to-speech-multilingual-v2';
 const input={text,voice:config.ttsVoice||'EkK5I93UQWFDigLMpZcX',stability:.5,similarity_boost:.75,style:0,speed:1,timestamps:false,...(model.endsWith('turbo-2-5')?{language_code:'zh'}:{})};
 const created=await request(API+'/createTask',config,ctx,{method:'POST',paid:true,data:{model,input}});
 const id=created.data?.taskId;if(typeof id!=='string'||!id||id.length>160)fail('PROVIDER_FAILED',502);
 // One persisted tutor attempt can create at most one task per segment. Never resubmit on timeout.
 for(let n=0;n<12;n++){
  ctx.guard();await wait(Math.min(2000+500*n,4000),ctx.signal);ctx.guard();
  const result=await request(API+'/recordInfo?taskId='+encodeURIComponent(id),config,ctx);
  const state=result.data?.state;if(state==='fail')fail('PROVIDER_FAILED',502);
  if(state==='success'){
   let output;try{output=JSON.parse(result.data.resultJson);}catch{fail('PROVIDER_FAILED',502);}
   const urls=output?.resultUrls;if(!Array.isArray(urls)||urls.length!==1)fail('PROVIDER_FAILED',502);
   const url=fileUrl(urls[0]);ctx.guard('read');
   // No API key is forwarded to the CDN; redirects cannot turn this into an arbitrary URL fetch.
   const response=await fetch(url,{redirect:'error',signal:AbortSignal.any([ctx.signal,AbortSignal.timeout(15000)])});
   const audio=await responseBytes(response,12*1024*1024);ctx.guard();
   const magic=audio.toString('ascii',0,4);if(!(magic==='RIFF'||magic==='OggS'||magic.startsWith('ID3')||(audio[0]===255&&(audio[1]&0xe0)===0xe0)))fail('PROVIDER_FAILED',502);
   await writeFile(file,audio);ctx.guard();return;
  }
  if(!['waiting','queuing','generating'].includes(state))fail('PROVIDER_FAILED',502);
 }
 fail('TIMEOUT');
}
