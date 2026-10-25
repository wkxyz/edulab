import {writeFile} from 'node:fs/promises';
import {fail} from './validation.mjs';import {jsonResponse} from './provider-http.mjs';
export async function minimaxSpeech(text,file,config,ctx){
 if(typeof text!=='string'||!text.trim()||text.length>160)fail('INVALID_LESSON');
 ctx.guard(true);
 const response=await fetch(config.ttsBase+'/t2a_v2',{method:'POST',redirect:'error',headers:{authorization:'Bearer '+config.ttsKey,'content-type':'application/json'},signal:AbortSignal.any([ctx.signal,AbortSignal.timeout(60000)]),body:JSON.stringify({
  model:config.ttsModel,text:text.replaceAll('(','（').replaceAll(')','）'),stream:false,output_format:'hex',language_boost:'Chinese',
  voice_setting:{voice_id:config.ttsVoice,speed:1,vol:1,pitch:0},
  audio_setting:{sample_rate:24000,bitrate:128000,format:'wav',channel:1},subtitle_enable:false
 })});
 const data=await jsonResponse(response,8*1024*1024);ctx.guard();
 if(data.base_resp?.status_code!==0||data.data?.status!==2)fail('PROVIDER_FAILED',502);
 const hex=data.data.audio;
 if(typeof hex!=='string'||!hex||hex.length>6*1024*1024||hex.length%2||!/^[a-fA-F0-9]+$/.test(hex))fail('PROVIDER_FAILED',502);
 const audio=Buffer.from(hex,'hex');
 if(audio.length<44||audio.toString('ascii',0,4)!=='RIFF'||audio.toString('ascii',8,12)!=='WAVE')fail('PROVIDER_FAILED',502);
 ctx.guard();await writeFile(file,audio);ctx.guard();
}
