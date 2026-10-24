import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import assert from 'node:assert/strict';
import {startServer} from '../server.mjs';import {runProcess} from '../render.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tutor-smoke-'));
const {server,tutor}=await startServer({dataDir:dir,port:0,renderOptions:{fps:6,scale:1}});
const base=`http://127.0.0.1:${server.address().port}`;let browser;
try{
 const {chromium}=await import('playwright');browser=await chromium.launch();const page=await browser.newPage({viewport:{width:390,height:844}});
 const issues=[];page.on('pageerror',e=>issues.push(e.message));
 await page.goto(base);await page.getByRole('heading',{name:'拍一道题，听懂每一步'}).waitFor();
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);
 await page.screenshot({path:path.join(dir,'mobile.png')});
 // A real upload must report disabled live service, never masquerade as the fixed sample.
 await page.locator('#file').setInputFiles({name:'question.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XKqkAAAAASUVORK5CYII=','base64')});
 await page.getByRole('button',{name:'生成视频讲解',exact:true}).click();await page.getByText('真实解题服务尚未开通，可先体验示例讲解。',{exact:true}).waitFor();
 await page.getByRole('button',{name:'体验示例讲解',exact:true}).click();
 await page.getByRole('button',{name:'取消本次生成',exact:true}).click();await page.getByText('任务已取消。',{exact:true}).waitFor();
 await page.getByRole('button',{name:'重新拍题',exact:true}).click();
 await page.getByRole('button',{name:'体验示例讲解',exact:true}).click();
 await page.getByRole('button',{name:'取消本次生成',exact:true}).waitFor();
 await page.screenshot({path:path.join(dir,'processing.png')});
 await page.getByRole('button',{name:'查看我的视频',exact:true}).click();
 await page.getByRole('button',{name:/一元一次方程/}).click();
 await page.locator('video').waitFor({timeout:240000});
 assert.match(new URL(page.url()).hash,/^#task\/[a-f0-9-]{36}$/);
 await page.reload();await page.locator('video').waitFor();
 await page.locator('video').evaluate(video=>new Promise((resolve,reject)=>{if(video.readyState>=1)return resolve();video.onloadedmetadata=resolve;video.onerror=()=>reject(new Error('video failed'));}));
 await page.locator('video').evaluate(video=>video.play());await page.waitForTimeout(1200);
 const playback=await page.locator('video').evaluate(v=>({duration:v.duration,currentTime:v.currentTime,width:v.videoWidth,height:v.videoHeight}));
 assert.ok(playback.currentTime>0);assert.equal(playback.width,1280);assert.equal(playback.height,720);
 await page.locator('video').evaluate(v=>new Promise(resolve=>{v.pause();v.addEventListener('seeked',()=>resolve(),{once:true});v.currentTime=Math.max(0,v.duration-3);}));
 await page.screenshot({path:path.join(dir,'result.png')});
 await page.setViewportSize({width:1280,height:900});await page.getByRole('button',{name:'拍题',exact:true}).click();await page.screenshot({path:path.join(dir,'desktop.png')});
 assert.deepEqual(issues,[]);
 const token=await page.evaluate(()=>localStorage.getItem('tutor-token'));const tasks=await fetch(base+'/api/tasks',{headers:{authorization:'Bearer '+token}}).then(r=>r.json());const task=tasks.tasks.find(t=>t.status==='completed');
 const range=await fetch(base+task.result.video,{headers:{Range:'bytes=0-1023'}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,1024);
 const probe=JSON.parse((await runProcess('ffprobe',['-v','error','-show_streams','-of','json',path.join(dir,'jobs',task.id,'video.mp4')])).toString());
 assert.ok(probe.streams.some(s=>s.codec_type==='audio'));assert.ok(probe.streams.some(s=>s.codec_type==='video'));
 console.log('SMOKE_RESULT',JSON.stringify({playback,stages:'upload disabled -> sample cancelled -> sample completed -> reload playback',httpRange:206,consoleErrors:issues.length,externalPaidCalls:0}));
 // Public sample UI only, never user uploads or credentials. Kept in the existing job log to avoid artifact storage.
 for(const name of ['mobile','processing','result','desktop'])console.log('QA_IMAGE_'+name.toUpperCase()+':'+fs.readFileSync(path.join(dir,name+'.png')).toString('base64'));
}finally{if(browser)await browser.close();await new Promise(r=>server.close(r));tutor.close();fs.rmSync(dir,{recursive:true,force:true});}
