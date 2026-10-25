import path from 'node:path';
export function configFromEnv(env=process.env){
 const int=(k,d,max)=>{const n=Number(env[k]??d);if(!Number.isSafeInteger(n)||n<0||n>max)throw new Error('Invalid configuration: '+k);return n;};
 const regionBase=(region,name)=>{if(!['cn','global'].includes(region))throw new Error('Invalid '+name);return region==='cn'?'https://api.minimax.cn/v1':'https://api.minimax.io/v1';};
 const c={dataDir:path.resolve(env.TUTOR_DATA_DIR||'../../.tutor-data'),host:env.HOST||'127.0.0.1',port:int('PORT',8788,65535),liveEnabled:env.LIVE_ENABLED==='true',stageQuota:true,projectBudgetCents:int('PROJECT_BUDGET_CENTS',2000,2000),lessonBudgetCents:int('LESSON_BUDGET_CENTS',100,2000),narrationBudgetCents:int('NARRATION_BUDGET_CENTS',200,2000),lessonTaskLimit:int('LESSON_TASK_LIMIT',0,200),narrationTaskLimit:int('NARRATION_TASK_LIMIT',0,200),liveTaskLimit:int('LIVE_TASK_LIMIT',200,200),dayBudgetCents:int('DAY_BUDGET_CENTS',0,10000),jobBudgetCents:int('JOB_BUDGET_CENTS',0,1000),aiBase:env.AI_BASE_URL||'',aiKey:env.AI_API_KEY||'',aiModel:env.AI_MODEL||''};
 if(c.aiBase&&!/^https:\/\/[^@?#]+$/.test(c.aiBase))throw new Error('AI_BASE_URL must use HTTPS');
 c.provider=env.AI_PROVIDER||'kie';if(!['kie','minimax','openai-compatible'].includes(c.provider))throw new Error('Invalid AI_PROVIDER');
 if(c.provider==='kie'){
  const model=env.KIE_CHAT_MODEL||'gemini-3-pro';if(!['gemini-3-pro','gemini-2.5-pro'].includes(model))throw new Error('Unsupported KIE_CHAT_MODEL');
  c.aiBase='https://api.kie.ai/'+model+'/v1';c.aiModel=model;c.aiKey=env.KIE_API_KEY||'';
 }else if(c.provider==='minimax'){
  c.aiBase=regionBase(env.MINIMAX_REGION||'cn','MINIMAX_REGION');c.aiModel='MiniMax-M3.1-Flash';c.aiKey=env.MINIMAX_API_KEY||'';
  c.reasoningEffort=env.MINIMAX_REASONING_EFFORT||'medium';if(!['low','medium','high','xhigh','max'].includes(c.reasoningEffort))throw new Error('Invalid MINIMAX_REASONING_EFFORT');
 }
 c.ttsProvider=env.TTS_PROVIDER||(c.provider==='minimax'?'minimax':c.provider==='kie'?'kie':'glm');
 if(c.ttsProvider==='minimax'){
  c.ttsBase=regionBase(env.MINIMAX_TTS_REGION||env.MINIMAX_REGION||'cn','MINIMAX_TTS_REGION');
  c.ttsKey=env.MINIMAX_TTS_API_KEY||env.MINIMAX_API_KEY||'';c.ttsModel=env.MINIMAX_TTS_MODEL||'speech-2.8-hd';c.ttsVoice=env.MINIMAX_TTS_VOICE||'female-chengshu';
  if(!['speech-2.8-hd','speech-2.8-turbo'].includes(c.ttsModel))throw new Error('Unsupported MINIMAX_TTS_MODEL');
 }else if(c.ttsProvider==='kie'){
  c.ttsKey=env.KIE_API_KEY||'';c.ttsModel=env.KIE_TTS_MODEL||'elevenlabs/text-to-speech-multilingual-v2';c.ttsVoice=env.KIE_TTS_VOICE||'EkK5I93UQWFDigLMpZcX';
  if(!['elevenlabs/text-to-speech-multilingual-v2','elevenlabs/text-to-speech-turbo-2-5'].includes(c.ttsModel))throw new Error('Unsupported KIE_TTS_MODEL');
 }else if(c.ttsProvider==='glm'){c.ttsKey=env.GLM_API_KEY||'';c.ttsVoice=env.GLM_VOICE||'chuichui';}
 else throw new Error('Invalid TTS_PROVIDER');
 c.adminToken=env.ADMIN_TOKEN||'';if(c.adminToken&&c.adminToken.length<32)throw new Error('ADMIN_TOKEN must contain at least 32 characters');
 c.lessonConfigured=!!(c.aiBase&&c.aiKey&&c.aiModel);c.narrationConfigured=!!c.ttsKey;
 c.configured=c.lessonConfigured&&c.narrationConfigured;return c;
}
