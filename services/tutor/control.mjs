import {configFromEnv} from './config.mjs';
const config=configFromEnv(),action=process.argv[2];
if(!['status','stop','resume'].includes(action)||!config.adminToken)throw new Error('Use control.mjs status|stop|resume with ADMIN_TOKEN configured.');
const response=await fetch(`http://127.0.0.1:${config.port}/api/admin/state`,{method:action==='status'?'GET':'POST',headers:{authorization:'Bearer '+config.adminToken,'content-type':'application/json'},...(action==='status'?{}:{body:JSON.stringify({stopped:action==='stop'})}),signal:AbortSignal.timeout(5000)});
if(!response.ok)throw new Error('Control request failed: HTTP '+response.status);
console.log(JSON.stringify(await response.json()));
