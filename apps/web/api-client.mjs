export function createClient({transport=fetch,storage=localStorage,message=()=> '暂时无法完成，请稍后重试。',requestTimeoutMs=15000}={}){
 let sessionPending;
 const session=async()=>{
  const token=storage.getItem('tutor-token');if(token)return token;
  if(!sessionPending)sessionPending=(async()=>{const s=await api('/api/session',{method:'POST',auth:false});storage.setItem('tutor-token',s.token);return s.token;})().finally(()=>{sessionPending=null;});
  return sessionPending;
 };
 async function api(url,{method='GET',data,auth=true,key}={}){
  const token=auth?await session():null;
  let response,result;
  try{
   response=await transport(url,{method,signal:AbortSignal.timeout(requestTimeoutMs),headers:{'content-type':'application/json',...(auth?{authorization:'Bearer '+token}:{}),...(key?{'idempotency-key':key}:{})},...(data!==undefined?{body:JSON.stringify(data)}:{})});
   result=await response.json();
  }catch(cause){
   const timedOut=cause.name==='TimeoutError';
   const error=new Error(timedOut?'连接超时，请检查网络后重试。':'连接失败，请检查网络后重试。',{cause});error.code=timedOut?'NETWORK_TIMEOUT':'NETWORK_ERROR';throw error;
  }
  if(!response.ok){if(response.status===401&&storage.getItem('tutor-token')===token)storage.removeItem('tutor-token');const error=new Error(message(result.error));error.code=result.error;throw error;}
  return result;
 }
 return api;
}
