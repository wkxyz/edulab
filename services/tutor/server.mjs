import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import {randomBytes,timingSafeEqual} from 'node:crypto';import {fileURLToPath,pathToFileURL} from 'node:url';
import {Tutor} from './service.mjs';import {createRunner} from './runner.mjs';import {configFromEnv} from './config.mjs';import {TutorError,fail} from './validation.mjs';
import {CAPABILITIES} from '../../apps/web/capabilities.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));};
async function body(req){let n=0;const chunks=[];for await(const chunk of req){n+=chunk.length;if(n>5601000)fail('PAYLOAD_TOO_LARGE',413);chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString());}catch(e){if(e instanceof TutorError)throw e;fail('INVALID_JSON');}}
export async function startServer(options={}){
 const config={...configFromEnv(),...options};const tutor=new Tutor({...config,runner:options.runner||createRunner(config)});
 const server=http.createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,'http://localhost'),p=url.pathname;
   if(p==='/api/admin/state'){
    const sent=Buffer.from((req.headers.authorization||'').replace(/^Bearer /,'')),expected=Buffer.from(config.adminToken||'');
    if(!expected.length)fail('NOT_FOUND',404);if(sent.length!==expected.length||!timingSafeEqual(sent,expected))fail('FORBIDDEN',403);
    if(req.method==='POST'){const data=await body(req);if(typeof data.stopped!=='boolean')fail('INVALID_STATE');tutor.setStopped(data.stopped);}
    else if(req.method!=='GET')fail('NOT_FOUND',404);
    return json(res,200,{stopped:tutor.isStopped(),running:tutor.running.size,queued:tutor.db.prepare("SELECT count(*) n FROM tasks WHERE status='queued'").get().n});
   }
   if(p==='/api/health'&&req.method==='GET')return json(res,200,{liveEnabled:config.liveEnabled&&!tutor.liveLimitReached()&&config.configured&&!tutor.isStopped()&&config.dayBudgetCents>0&&config.jobBudgetCents>0,liveLimitReached:tutor.liveLimitReached(),stopped:tutor.isStopped(),sampleAvailable:['darwin','linux'].includes(process.platform),maxImageBytes:4194304});
   if(p==='/api/capabilities'&&req.method==='GET')return json(res,200,{capabilities:CAPABILITIES.map(({id,title,kind,subject,description,random,styles})=>({id,title,kind,subject,description,random,styles}))});
   if(p==='/api/session'&&req.method==='POST'){
    if(tutor.isStopped())fail('STOPPED',503);
    const count=tutor.db.prepare('SELECT count(*) n FROM sessions WHERE expires>?').get(Date.now()).n;if(count>=500)fail('SESSION_LIMIT',429);
    tutor.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    const token=randomBytes(32).toString('hex');tutor.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(token,Date.now(),Date.now()+30*86400000);return json(res,201,{token});
   }
   if(p.startsWith('/api/')&&tutor.isStopped())fail('STOPPED',503);
   const media=/^\/api\/media\/([a-f0-9-]{36})\/(video\.mp4|cover\.png|preview\.html|lesson\.html|audio\.wav|subtitles\.srt)$/.exec(p);
   if(media){
    if(!['GET','HEAD'].includes(req.method))fail('NOT_FOUND',404);
    const row=tutor.db.prepare("SELECT media_token,expires FROM tasks WHERE id=? AND status='completed'").get(media[1]);
    const token=Buffer.from(url.searchParams.get('token')||'');if(!row||token.length!==row.media_token.length||!timingSafeEqual(token,Buffer.from(row.media_token)))fail('NOT_FOUND',404);
    const file=path.join(config.dataDir,'jobs',media[1],media[2]);if(!fs.existsSync(file))fail('NOT_FOUND',404);
    const size=fs.statSync(file).size,range=req.headers.range;let start=0,end=size-1,status=200;
    if(range){const m=/^bytes=(\d+)-(\d*)$/.exec(range);if(!m)fail('INVALID_RANGE',416);start=Number(m[1]);end=m[2]?Math.min(Number(m[2]),end):end;if(start>end||start>=size)fail('INVALID_RANGE',416);status=206;}
    const types={'video.mp4':'video/mp4','cover.png':'image/png','preview.html':'text/html; charset=utf-8','lesson.html':'text/html; charset=utf-8','audio.wav':'audio/wav','subtitles.srt':'text/plain; charset=utf-8'};
    const html=media[2].endsWith('.html');
    res.writeHead(status,{'content-type':types[media[2]],'cache-control':'private, max-age=300','accept-ranges':'bytes','content-length':end-start+1,'x-content-type-options':'nosniff','referrer-policy':'no-referrer',...(html?{'content-security-policy':"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data:; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'"}:{}),...(['lesson.html','subtitles.srt'].includes(media[2])?{'content-disposition':`attachment; filename="edulab-${media[2]}"`}:{}),...(status===206?{'content-range':`bytes ${start}-${end}/${size}`}:{})});if(req.method==='HEAD'){res.end();return;}fs.createReadStream(file,{start,end}).pipe(res);return;
   }
   if(p.startsWith('/api/')){
    const token=(req.headers.authorization||'').replace(/^Bearer /,'');
    if(!/^[a-f0-9]{64}$/.test(token)||!tutor.db.prepare('SELECT token FROM sessions WHERE token=? AND expires>?').get(token,Date.now()))fail('INVALID_SESSION',401);
    if(p==='/api/tasks'&&req.method==='GET')return json(res,200,{tasks:tutor.list(token)});
    if(p==='/api/tasks'&&req.method==='POST'){if(req.headers['content-type']?.split(';')[0]!=='application/json')fail('INVALID_CONTENT_TYPE');return json(res,202,tutor.create(await body(req),token,req.headers['idempotency-key']));}
    const match=/^\/api\/tasks\/([a-f0-9-]{36})(\/cancel|\/export)?$/.exec(p);
    if(match){if(match[2]==='/cancel'&&req.method==='POST')return json(res,200,tutor.cancel(match[1],token));if(match[2]==='/export'&&req.method==='POST')return json(res,202,tutor.createExport(match[1],token));if(!match[2]&&req.method==='GET'){const task=tutor.get(match[1],token);if(!task)fail('NOT_FOUND',404);return json(res,200,task);}}
    fail('NOT_FOUND',404);
   }
   if(!['GET','HEAD'].includes(req.method))fail('NOT_FOUND',404);
   const root=path.resolve(HERE,'../../apps/web'),files={'/':'index.html','/app.js':'app.js','/api-client.mjs':'api-client.mjs','/ui.mjs':'ui.mjs','/capabilities.mjs':'capabilities.mjs','/photo-editor.mjs':'photo-editor.mjs','/style.css':'style.css'};
   const name=files[p];if(!name||!fs.existsSync(path.join(root,name)))fail('NOT_FOUND',404);
   const data=fs.readFileSync(path.join(root,name));res.writeHead(200,{'content-type':/\.m?js$/.test(name)?'text/javascript; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','x-content-type-options':'nosniff','cache-control':'no-cache','referrer-policy':'no-referrer'});res.end(req.method==='HEAD'?undefined:data);
  }catch(e){if(!res.headersSent)json(res,e instanceof TutorError?e.status:500,{error:e instanceof TutorError?e.code:'INTERNAL_ERROR'});else res.destroy();}
 });
 server.requestTimeout=15000;server.headersTimeout=10000;
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.host,resolve);});
 if(config.autoRun!==false)tutor.wake();return {server,tutor,config};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const app=await startServer();console.log(`题解开发服务：http://${app.config.host}:${app.server.address().port} （真实API：${app.config.liveEnabled&&app.config.configured?'已配置':'关闭'}）`);for(const s of ['SIGINT','SIGTERM'])process.once(s,()=>{app.tutor.setStopped(true);app.server.close(()=>{app.tutor.close();process.exit(0);});});}
