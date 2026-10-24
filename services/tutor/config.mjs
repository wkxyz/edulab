import path from 'node:path';
export function configFromEnv(env=process.env){
 const int=(k,d,max)=>{const n=Number(env[k]??d);if(!Number.isSafeInteger(n)||n<0||n>max)throw new Error(`Invalid configuration: ${k}`);return n;};
 const c={dataDir:path.resolve(env.TUTOR_DATA_DIR||'../../.tutor-data'),host:env.HOST||'127.0.0.1',port:int('PORT',8788,65535),liveEnabled:env.LIVE_ENABLED==='true',dayBudgetCents:int('DAY_BUDGET_CENTS',0,10000),jobBudgetCents:int('JOB_BUDGET_CENTS',0,1000),aiBase:env.AI_BASE_URL||'',aiKey:env.AI_API_KEY||'',aiModel:env.AI_MODEL||'',ttsKey:env.GLM_API_KEY||'',ttsVoice:env.GLM_VOICE||'chuichui'};
 if(c.aiBase&&!/^https:\/\/[^@?#]+$/.test(c.aiBase))throw new Error('AI_BASE_URL must use HTTPS');
 c.configured=!!(c.aiBase&&c.aiKey&&c.aiModel&&c.ttsKey);return c;
}
