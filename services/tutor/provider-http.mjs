import {fail} from './validation.mjs';
const providerFailure=code=>fail([504,524].includes(Number(code))?'PROVIDER_TIMEOUT':'PROVIDER_FAILED',502);
export async function responseBytes(response,max){
 if(!response.ok)providerFailure(response.status);
 if(!response.body)fail('PROVIDER_FAILED',502);
 const reader=response.body.getReader();let size=0;const chunks=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max)fail('PROVIDER_FAILED',502);chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 return Buffer.concat(chunks);
}
export async function jsonResponse(response,max=100000){
 let data;try{data=JSON.parse((await responseBytes(response,max)).toString());}catch(e){if(['PROVIDER_FAILED','PROVIDER_TIMEOUT'].includes(e.code))throw e;fail('PROVIDER_FAILED',502);}
 if(!data||typeof data!=='object')fail('PROVIDER_FAILED',502);
 if(data.code!==undefined&&data.code!==200)providerFailure(data.code);return data;
}
