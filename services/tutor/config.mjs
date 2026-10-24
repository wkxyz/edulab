import path from 'node:path';
export function configFromEnv(env=process.env){
 const int=(k,d,max)=>{const n=Number(env[k]??d);if(!Number.isSafeInteger(n)||n<0||n>max)throw new Error(`Invalid configuration: ${k}`);return n;};
 const c={dataDir:path.resolve(env.TUTOR_DATA_DIR||'../../.tutor-data'),host:env.HOST||'127.0.0.1',port:int('PORT',8788,65535),liveEnabled:env.LIVE_ENABLED==='true',dayBudgetCents:int('DAY_BUDGET_CENTS',0,10000),jobBudgetCents:int('JOB_BUDGET_CENTS',0,1000),aiBase:env.AI_BASE_URL||'',aiKey:env.AI_API_KEY||'',aiModel:env.AI_MODEL||'',ttsKey:env.GLM_API_KEY||'',ttsVoice:env.GLM_VOICE||'chuichui'};
 if(c.aiBase&&!/^https:\/\/[^@?#]+$/.test(c.aiBase))throw new Error('AI_BASE_URL must use HTTPS');
 c.provider=env.AI_PROVIDER||'kie';
 if(!['kie','openai-compatible'].includes(c.provider))throw new Error('Invalid AI_PROVIDER');
 if(c.provider==='kie'){
  const model=env.KIE_CHAT_MODEL||'gemini-3-pro';if(!['gemini-3-pro','gemini-2.5-pro'].includes(model))throw new Error('Unsupported KIE_CHAT_MODEL');
  c.aiBase=`https://api.kie.ai/${model}/v1`;c.aiModel=model;c.aiKey=env.KIE_API_KEY||'';c.ttsKey=c.aiKey;c.ttsProvider='kie';
  c.ttsModel=env.KIE_TTS_MODEL||'elevenlabs/text-to-speech-multilingual-v2';
  if(!['elevenlabs/text-to-speech-multilingual-v2','elevenlabs/text-to-speech-turbo-2-5'].includes(c.ttsModel))throw new Error('Unsupported KIE_TTS_MODEL');
  c.ttsVoice=env.KIE_TTS_VOICE||'EkK5I93UQWFDigLMpZcX';
 }else c.ttsProvider='glm';
 c.adminToken=env.ADMIN_TOKEN||'';if(c.adminToken&&c.adminToken.length<32)throw new Error('ADMIN_TOKEN must contain at least 32 characters');
 c.configured=!!(c.aiBase&&c.aiKey&&c.aiModel&&c.ttsKey);return c;
}
