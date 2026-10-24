// Disposable, provider-free integration QA. Run after installing the tutor's
// locked dependencies, Chromium, ffmpeg, espeak-ng and Python sympy.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {startServer} from '../server.mjs';
import {runProcess} from '../render.mjs';

const TOTAL_MS=9*60*1000,TASK_MS=300000,UI_MS=20000;
const tempRoot=fs.mkdtempSync(path.join(os.tmpdir(),'tutor-capabilities-smoke-'));
const deadline=Date.now()+TOTAL_MS,realFetch=globalThis.fetch;
let server,tutor,browser,context,base,token,timedOut=false;
const pageErrors=[],externalRequests=[],badResponses=[],screenshots=new Map(),results=[];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const remaining=()=>{assert.ok(!timedOut&&Date.now()<deadline,'capabilities smoke exceeded its total time limit');return deadline-Date.now();};
const watchdog=setTimeout(()=>{timedOut=true;try{tutor?.setStopped(true);}catch{}browser?.close().catch(()=>{});},TOTAL_MS);
watchdog.unref();

function normalizeMath(value){
  return String(value).normalize('NFKC').replace(/\\(?:left|right)/g,'').replace(/\\dfrac/g,'\\frac').replace(/\\[,;! ]/g,'').replace(/[\s$]/g,'');
}
function assertAnswer(task){
  const answer=normalizeMath(task.result.answer);
  switch(task.capability){
    case 'solid-geometry':assert.equal(answer,'\\frac{2\\sqrt{22}}{11}');break;
    case 'analytic-geometry':assert.equal(answer,'[-3,\\frac{7}{4}]');break;
    case 'math-video':assert.equal(answer,'x=4');break;
    case 'physics-video':assert.match(answer,/a=3m\/s(?:\^?2)/);assert.match(answer,/s=6m(?:$|[，,])/);break;
    case 'chem-reaction':case 'chem-video':{
      // Typography may be Unicode or TeX. Check the balanced coefficients and
      // species, while preserving the reaction direction and its two sides.
      let chemical=String(task.result.answer).normalize('NFKC').replace(/\\(?:mathrm|text|ce)\{([^{}]*)\}/g,'$1');
      chemical=chemical.replace(/\\(?:xrightarrow|overset)\{(?:\\text\{[^{}]*\}|[^{}]*)\}/g,'→').replace(/\\(?:longrightarrow|rightarrow)/g,'→');
      chemical=chemical.replace(/\\[,;! ]|[\s${}_]/g,'');
      assert.match(chemical,/CH4\+2O2.*(?:→|=).*CO2\+2H2O/);break;
    }
    default:assert.fail('unexpected capability');
  }
}
async function api(route,{method='GET',data,key}={}){
  remaining();const response=await fetch(base+route,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),...(data!==undefined?{'content-type':'application/json'}:{}),...(key?{'idempotency-key':key}:{})},...(data!==undefined?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(Math.min(15000,remaining()))});
  const value=await response.json();assert.ok(response.ok,`${method} ${route.split('?')[0]} returned ${response.status}: ${value.error||'request failed'}`);return value;
}
async function waitTask(id){
  const end=Math.min(deadline,Date.now()+TASK_MS);
  while(Date.now()<end){
    const task=await api('/api/tasks/'+id);
    if(task.status==='completed')return task;
    assert.ok(['queued','running'].includes(task.status),`${task.capability} ended as ${task.status}/${task.error||task.stage}`);
    await sleep(600);
  }
  assert.fail('task did not complete before its bounded timeout');
}
async function validArtifact(url,{type,attachment=false}={}){
  assert.equal(typeof url,'string');const target=new URL(url,base);assert.equal(target.origin,base);
  const response=await fetch(target,{signal:AbortSignal.timeout(Math.min(20000,remaining()))});
  assert.equal(response.status,200,`artifact ${target.pathname} must be readable`);
  if(type)assert.match(response.headers.get('content-type')||'',type);
  if(attachment)assert.match(response.headers.get('content-disposition')||'',/attachment/);
  const body=await response.arrayBuffer();assert.ok(body.byteLength>0);return body.byteLength;
}
async function openResult(page,task){
  await page.goto(base+'/#task/'+task.id,{waitUntil:'domcontentloaded',timeout:UI_MS});
  await page.getByRole('heading',{name:task.result.title,exact:true}).waitFor({timeout:UI_MS});
  const iframe=page.locator('iframe.lesson-preview').first();await iframe.waitFor({state:'visible',timeout:UI_MS});
  assert.equal(await iframe.getAttribute('sandbox'),'allow-scripts');
  assert.equal(await page.locator('video').count(),0,'preview-first tasks must not invent a video URL');
  await page.getByRole('button',{name:'放大观看',exact:true}).click();
  const frame=await (await iframe.elementHandle()).contentFrame();assert.ok(frame);
  await frame.waitForFunction(()=>document.readyState==='complete',null,{timeout:UI_MS});
  await frame.evaluate(()=>document.fonts.ready);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'result page must fit its viewport');
  return frame;
}
async function canvasReady(frame,selector){
  const canvas=frame.locator(selector).first();await canvas.waitFor({state:'visible',timeout:UI_MS});
  await frame.waitForFunction(selector=>{const canvas=document.querySelector(selector),box=canvas?.getBoundingClientRect();return !!canvas&&canvas.width>0&&canvas.height>0&&box.width>100&&box.height>100;},selector,{timeout:UI_MS});
  await canvas.scrollIntoViewIfNeeded();await frame.page().waitForTimeout(200);return canvas;
}
async function interactiveProof(page,frame,task){
  let canvas,before,after,readoutBefore,readoutAfter;
  if(task.capability==='solid-geometry'){
    canvas=await canvasReady(frame,'#canvas-container canvas');before=await canvas.screenshot();
    const box=await canvas.boundingBox();assert.ok(box);
    await page.mouse.move(box.x+box.width*.45,box.y+box.height*.45);await page.mouse.down();
    await page.mouse.move(box.x+box.width*.65,box.y+box.height*.55,{steps:12});await page.mouse.up();
    await page.waitForTimeout(350);after=await canvas.screenshot();
    assert.notDeepEqual(after,before,'rotating the solid must change rendered pixels');
    readoutBefore=await frame.locator('#step-indicator').innerText();await frame.locator('#next-btn').click();
    await frame.waitForFunction(previous=>document.querySelector('#step-indicator').textContent!==previous,readoutBefore,{timeout:UI_MS});
    readoutAfter=await frame.locator('#step-indicator').innerText();
    screenshots.set('SOLID',await page.screenshot());
  }else if(task.capability==='analytic-geometry'){
    canvas=await canvasReady(frame,'#geometry-canvas');before=await canvas.screenshot();
    readoutBefore=await frame.locator('#readouts').innerText();
    const slider=frame.locator('#param-slider');await slider.focus();await slider.press('End');
    await frame.waitForFunction(previous=>document.querySelector('#readouts').textContent!==previous,readoutBefore,{timeout:UI_MS});
    readoutAfter=await frame.locator('#readouts').innerText();await page.waitForTimeout(200);after=await canvas.screenshot();
    assert.notDeepEqual(after,before,'changing the analytic parameter must change rendered pixels');
    screenshots.set('ANALYTIC',await page.screenshot());
  }else{
    canvas=await canvasReady(frame,'#canvas-container canvas');before=await canvas.screenshot();
    readoutBefore=await frame.locator('#progress-readout').innerText();
    const slider=frame.locator('#reaction-slider');await slider.focus();await slider.press('End');
    await frame.waitForFunction(()=>document.querySelector('#progress-readout').textContent.trim()==='100%',null,{timeout:UI_MS});
    readoutAfter=await frame.locator('#progress-readout').innerText();await page.waitForTimeout(350);after=await canvas.screenshot();
    assert.notDeepEqual(after,before,'reaction progress must change the molecular scene');
    assert.match(await frame.locator('#conservation-chips').innerText(),/C|H|O/);
    screenshots.set('CHEMISTRY',await page.screenshot());
  }
  assert.notEqual(readoutAfter,readoutBefore,'the operated control must change its readout');
  return {changedPixels:true,changedReadout:true};
}
async function seekPreview(frame,ratio){
  const slider=frame.locator('#seek');
  if(await slider.count()){
    await slider.focus();await slider.press('Home');
    for(let i=0;i<Math.round(ratio*10);i++)await slider.press('PageUp');
  }else{
    const bar=frame.locator('#bar'),box=await bar.boundingBox();assert.ok(box&&box.width>10);
    await bar.click({position:{x:box.width*ratio,y:box.height/2}});
  }
}
async function videoPreviewProof(page,frame,{handdrawn=false,capability}){
  const animated=capability!=='math-video'||handdrawn;
  if(animated){await canvasReady(frame,'#c');await frame.evaluate(async()=>{if(window.ready)await window.ready;});}
  else{
    await frame.locator('#stage').waitFor({state:'visible',timeout:UI_MS});
    await frame.waitForFunction(()=>!!globalThis.SV?.state()?.ready,null,{timeout:UI_MS});
    await frame.evaluate(()=>SV.state().ready);assert.deepEqual(await frame.evaluate(()=>SV.report()),[]);
    assert.ok(await frame.locator('#stage .ln').count()>0,'ordinary board preview must contain rendered lesson lines');
  }
  await frame.waitForFunction(()=>{const audio=document.querySelector('audio');return !!audio&&audio.readyState>=1&&Number.isFinite(audio.duration)&&audio.duration>0;},null,{timeout:UI_MS});
  const audioBefore=await frame.locator('audio').evaluate(audio=>({duration:audio.duration,currentTime:audio.currentTime,embedded:audio.currentSrc.startsWith('data:audio/wav')}));assert.equal(audioBefore.embedded,true);
  await frame.locator('#play').click();
  await frame.waitForFunction(()=>{const audio=document.querySelector('audio');return !audio.paused&&audio.currentTime>.15;},null,{timeout:10000});
  await frame.locator('#play').click();
  await frame.waitForFunction(()=>document.querySelector('audio').paused,null,{timeout:5000});
  const visual=frame.locator(animated?'#c':'#stage');const before=await visual.screenshot();
  await seekPreview(frame,.4);
  await frame.waitForFunction(()=>{const audio=document.querySelector('audio');return audio.currentTime/audio.duration>.25&&audio.currentTime/audio.duration<.6;},null,{timeout:5000});
  const middle=await frame.locator('audio').evaluate(audio=>audio.currentTime);await page.waitForTimeout(200);const after=await visual.screenshot();
  assert.notDeepEqual(after,before,'seeking the narrated preview must change the visible lesson');
  const timeBefore=await frame.locator('#tm').innerText();await seekPreview(frame,.2);
  await frame.waitForFunction(previous=>{const audio=document.querySelector('audio');return audio.currentTime<previous-1;},middle,{timeout:5000});
  await frame.waitForFunction(previous=>document.querySelector('#tm').textContent!==previous,timeBefore,{timeout:5000});
  if(animated){const report=await frame.evaluate(()=>window.ANIMATION_REPORT);assert.equal(report?.trustedDispatcher,true);assert.deepEqual(report.errors,[]);}
  return {audioSeconds:audioBefore.duration,played:true,seeked:true,reseeked:true,changedPixels:true,engine:animated?'animation':'board'};
}

try{
  ({server,tutor}=await startServer({dataDir:tempRoot,host:'127.0.0.1',port:0,ownerLimit:30,dailyLimit:60,renderOptions:{fps:3},maxMs:TASK_MS,liveEnabled:false,configured:false,aiKey:'',ttsKey:'',aiBase:'',aiModel:'',dayBudgetCents:0,jobBudgetCents:0}));
  base=`http://127.0.0.1:${server.address().port}`;
  // Enforce local-only HTTP at the Node boundary as well as in every browser
  // page. The default runner must never attempt a provider call for these jobs.
  globalThis.fetch=async(input,options)=>{const url=new URL(input instanceof Request?input.url:String(input));if(url.origin!==base){externalRequests.push('node:'+url.origin+url.pathname);throw new Error('External HTTP is forbidden in capabilities smoke');}return realFetch(input,options);};
  assert.equal((await api('/api/health')).liveEnabled,false);({token}=await api('/api/session',{method:'POST'}));
  assert.match(token,/^[a-f0-9]{64}$/);
  browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader'],...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
  context=await browser.newContext({viewport:{width:1280,height:960},deviceScaleFactor:1});context.setDefaultTimeout(UI_MS);
  await context.addInitScript(({value,origin})=>{if(window.top===window&&location.origin===origin)localStorage.setItem('tutor-token',value);},{value:token,origin:base});
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(['http:','https:'].includes(url.protocol)&&url.origin!==base){externalRequests.push('browser:'+url.origin+url.pathname);return route.abort();}return route.continue();});
  context.on('page',page=>{
    page.on('pageerror',error=>pageErrors.push(error.message));
    page.on('response',response=>{const url=new URL(response.url());if(response.status()>=400&&url.pathname!=='/favicon.ico')badResponses.push({path:url.pathname,status:response.status()});});
  });
  const page=await context.newPage();
  const examples=[
    {capability:'solid-geometry'}, {capability:'analytic-geometry'}, {capability:'chem-reaction'},
    {capability:'math-video'}, {capability:'physics-video'}, {capability:'chem-video'},
    {capability:'math-video',handdrawn:true},
  ];
  const completed=[];
  for(const example of examples){
    remaining();const interactive=['solid-geometry','analytic-geometry','chem-reaction'].includes(example.capability);
    const created=await api('/api/tasks',{method:'POST',data:{capability:example.capability,sampleId:'default',...(interactive?{}:{exportVideo:false,style:example.handdrawn?'handdrawn':'chalk'})},key:'capability_smoke_'+randomUUID()});
    const task=await waitTask(created.id);assert.equal(task.capability,example.capability);assert.equal(task.mode,'sample');assert.equal(task.result.format,interactive?'interactive':'video');assert.equal(task.result.video,undefined);assertAnswer(task);
    await validArtifact(task.result.preview,{type:/text\/html/});await validArtifact(task.result.download,{type:/text\/html/,attachment:true});
    if(!interactive){assert.ok(task.result.duration>0);await validArtifact(task.result.subtitles,{type:/text\/plain/,attachment:true});}
    const frame=await openResult(page,task),proof=interactive?await interactiveProof(page,frame,task):await videoPreviewProof(page,frame,example);
    assert.deepEqual(pageErrors,[]);assert.deepEqual(externalRequests,[]);assert.deepEqual(badResponses,[]);
    completed.push(task);results.push({capability:task.capability,format:task.result.format,variant:example.handdrawn?'handdrawn':'default',answerChecked:true,...proof});
  }

  // Exercise the actual frontend export action and follow the new render-only
  // task. Original solution/TTS attempts and counters must remain unchanged.
  const source=completed.find(task=>task.capability==='physics-video');
  const beforeSource=tutor.db.prepare('SELECT attempts,calls,requests FROM tasks WHERE id=?').get(source.id);
  await openResult(page,source);
  const pendingExport=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===`/api/tasks/${source.id}/export`,{timeout:UI_MS});
  await page.getByRole('button',{name:'导出 MP4 视频',exact:true}).click();
  const exportResponse=await pendingExport;assert.equal(exportResponse.status(),202);const exported=await exportResponse.json();assert.notEqual(exported.id,source.id);assert.equal(exported.mode,'export');
  await page.waitForURL(base+'/#task/'+exported.id,{timeout:UI_MS});
  const videoTask=await waitTask(exported.id);assert.equal(videoTask.result.format,'video');assert.equal(videoTask.capability,source.capability);assertAnswer(videoTask);assert.ok(videoTask.result.video);
  const afterSource=tutor.db.prepare('SELECT attempts,calls,requests FROM tasks WHERE id=?').get(source.id);assert.deepEqual(afterSource,beforeSource);assert.equal(afterSource.calls,0);assert.equal(afterSource.requests,0);
  assert.equal((await api('/api/tasks/'+source.id)).status,'completed');
  const output=path.join(tempRoot,'jobs',videoTask.id,'video.mp4');assert.ok(fs.statSync(output).size>1024);
  const probe=JSON.parse((await runProcess(process.env.FFPROBE||'ffprobe',['-v','error','-show_streams','-show_format','-of','json',output],{signal:AbortSignal.timeout(Math.min(20000,remaining()))})).toString());
  const stream=probe.streams.find(stream=>stream.codec_type==='video');assert.ok(stream);assert.equal(stream.width,1280);assert.equal(stream.height,720);assert.ok(Number(probe.format.duration)>0);assert.ok(probe.streams.some(stream=>stream.codec_type==='audio'));
  const ranged=await fetch(new URL(videoTask.result.video,base),{headers:{range:'bytes=0-1023'},signal:AbortSignal.timeout(15000)});assert.equal(ranged.status,206);assert.equal((await ranged.arrayBuffer()).byteLength,1024);assert.match(ranged.headers.get('content-range')||'',/^bytes 0-1023\//);
  await page.goto(base+'/#task/'+videoTask.id,{waitUntil:'domcontentloaded',timeout:UI_MS});const video=page.locator('#video');await video.waitFor({state:'visible',timeout:UI_MS});
  await page.waitForFunction(()=>{const video=document.querySelector('video');return video?.readyState>=1&&video.duration>0;},null,{timeout:UI_MS});
  const player=await video.evaluate(video=>({duration:video.duration,width:video.videoWidth,height:video.videoHeight}));assert.ok(player.duration>0);assert.equal(player.width,1280);assert.equal(player.height,720);
  await video.evaluate(video=>{video.muted=true;return video.play();});await page.waitForFunction(()=>document.querySelector('video').currentTime>.15,null,{timeout:10000});await video.evaluate(video=>video.pause());screenshots.set('MP4_EXPORT',await page.screenshot());
  const beforeRepeat=tutor.db.prepare('SELECT attempts,calls,requests FROM tasks WHERE id=?').get(videoTask.id),beforeFile=fs.statSync(output),beforeCount=tutor.db.prepare('SELECT count(*) count FROM tasks').get().count;
  const repeated=await api('/api/tasks/'+source.id+'/export',{method:'POST'});assert.equal(repeated.id,videoTask.id);assert.equal(repeated.status,'completed');await sleep(250);
  assert.deepEqual(tutor.db.prepare('SELECT attempts,calls,requests FROM tasks WHERE id=?').get(videoTask.id),beforeRepeat);assert.equal(fs.statSync(output).mtimeMs,beforeFile.mtimeMs);assert.equal(tutor.db.prepare('SELECT count(*) count FROM tasks').get().count,beforeCount);assert.equal(beforeRepeat.calls,0);assert.equal(beforeRepeat.requests,0);
  assert.equal(JSON.parse(tutor.db.prepare('SELECT input FROM tasks WHERE id=?').get(videoTask.id).input).exportOf,source.id);
  assert.deepEqual(tutor.db.prepare("SELECT id FROM tasks WHERE calls<>0 OR requests<>0 OR reserve<>0 OR mode NOT IN ('sample','export')").all(),[]);
  assert.equal(tutor.db.prepare('SELECT coalesce(sum(calls),0) calls FROM daily').get().calls,0);assert.equal(tutor.db.prepare('SELECT coalesce(sum(cost),0) cost FROM daily').get().cost,0);
  assert.deepEqual(pageErrors,[]);assert.deepEqual(externalRequests,[]);assert.deepEqual(badResponses,[]);
  console.log('CAPABILITIES_SMOKE_RESULT',JSON.stringify({examples:results,export:{width:stream.width,height:stream.height,duration:Number(probe.format.duration),audio:true,played:true,range:206,newTask:true,repeatReused:true,sourceUnchanged:true,paidCalls:0},pageErrors:0,externalHttpRequests:0}));
  // Only the four selected public fixtures are emitted. No user-uploaded data or
  // session tokens are included; temporary files are removed below.
  for(const [name,buffer]of screenshots)console.log('CAPABILITIES_QA_IMAGE_'+name+':'+buffer.toString('base64'));
}finally{
  clearTimeout(watchdog);globalThis.fetch=realFetch;
  try{tutor?.setStopped(true);}catch{}
  if(context)await context.close().catch(()=>{});
  if(browser)await browser.close().catch(()=>{});
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  if(tutor){tutor.close();const end=Date.now()+15000;while(tutor.running.size&&Date.now()<end)await sleep(100);}
  fs.rmSync(tempRoot,{recursive:true,force:true});
}
