import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';import {spawn} from 'node:child_process';
import {compile,expandIntro,toSrt} from '../../skills/edu-math-video/lesson/scripts/compile.mjs';
import {makePage} from '../../skills/edu-math-video/lesson/scripts/build.mjs';
import {fail} from './validation.mjs';
import {withBrowser} from './browser-session.mjs';
import {makeStandalonePreview} from './artifact-assets.mjs';

export function runProcess(command,args,{signal,cwd,maxBytes=32*1024*1024}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{cwd,signal,stdio:['ignore','pipe','pipe']});const chunks=[];let size=0;
  child.stdout.on('data',b=>{size+=b.length;if(size>maxBytes){child.kill();return;}chunks.push(b);});
  child.stderr.resume();
  child.on('error',reject);child.on('close',code=>code===0&&size<=maxBytes?resolve(Buffer.concat(chunks)):reject(new Error('PROCESS_FAILED: '+path.basename(command)+' '+code)));
 });
}
export async function duration(file,signal){return Number((await runProcess(process.env.FFPROBE||'ffprobe',['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',file],{signal})).toString().trim());}
export async function narrateOffline(text,file,ctx){
 ctx.guard();
 if(process.platform==='linux'){await runProcess('espeak-ng',['-v','cmn','-s','190','-w',file,text],{signal:ctx.signal});ctx.guard();return;}
 if(process.platform!=='darwin')fail('NOT_CONFIGURED');
 const aiff=file+'.aiff';await runProcess('say',['-v','Tingting','-r','210','-o',aiff,text],{signal:ctx.signal});
 await runProcess(process.env.FFMPEG||'ffmpeg',['-v','error','-y','-i',aiff,'-ar','24000','-ac','1',file],{signal:ctx.signal});fs.rmSync(aiff);ctx.guard();
}
export async function mixTimelineAudio(timeline,outDir,ctx){
 if(!Number.isFinite(timeline.duration)||timeline.duration<=0||timeline.duration>240)fail('LESSON_TOO_LONG');
 const sr=24000,pcm=new Int16Array(Math.ceil(timeline.duration*sr));
 for(const clip of timeline.audio){
  ctx.guard();if(!Number.isFinite(clip.at)||clip.at<0||clip.at>timeline.duration)fail('INVALID_LESSON');
  const raw=await runProcess(process.env.FFMPEG||'ffmpeg',['-v','error','-i',clip.file,'-f','s16le','-ac','1','-ar','24000','-'],{signal:ctx.signal});
  const src=new Int16Array(raw.buffer,raw.byteOffset,raw.length/2);const off=Math.round(clip.at*sr);
  for(let i=0;i<src.length&&off+i<pcm.length;i++)pcm[off+i]=Math.max(-32768,Math.min(32767,pcm[off+i]+src[i]));
 }
 const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(36+pcm.byteLength,4);h.write('WAVE',8);h.write('fmt ',12);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(sr,24);h.writeUInt32LE(sr*2,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.byteLength,40);
 fs.writeFileSync(path.join(outDir,'audio.wav'),Buffer.concat([h,Buffer.from(pcm.buffer)]));ctx.guard();
}
export async function publicPreview(outDir,kind,ctx){
 ctx.guard();const source=fs.readFileSync(path.join(outDir,'preview.html'),'utf8');
 const html=await makeStandalonePreview(source,{kind,jobDir:outDir});ctx.guard();
 if(Buffer.byteLength(html)>40*1024*1024)fail('LESSON_TOO_LONG');
 fs.writeFileSync(path.join(outDir,'preview.html'),html);fs.writeFileSync(path.join(outDir,'lesson.html'),html);
}
async function openArtifact(browser,outDir){
 const page=await browser.newPage({viewport:{width:1280,height:720},deviceScaleFactor:1});
 page.artifactErrors=[];page.on('pageerror',error=>page.artifactErrors.push(error.message));
 const allowed=pathToFileURL(path.join(outDir,'preview.html')).href;
 await page.route('**/*',route=>{const u=route.request().url();return u.split('?')[0]===allowed||u.startsWith('data:')||u.startsWith('blob:')?route.continue():route.abort();});
 await page.goto(allowed+'?mode=render&render=1',{waitUntil:'load',timeout:20000});
 return page;
}
async function launchBrowser(){
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
 return chromium.launch({headless:true,args:['--enable-unsafe-swiftshader'],...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})});
}
export async function captureInteractiveCover(outDir,ctx){
 return withBrowser(ctx.signal,launchBrowser,async browser=>{
  const page=await openArtifact(browser,outDir);
  await page.waitForFunction(()=>globalThis.EDULAB_INTERACTIVE_READY===true,undefined,{timeout:15000});
  await page.waitForFunction(()=>document.querySelector('canvas')?.width>0,undefined,{timeout:15000});
  await page.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});ctx.guard();
  if(page.artifactErrors.length)fail('INTERACTIVE_RENDER_FAILED');
  await page.screenshot({path:path.join(outDir,'cover.png')});return {coverReady:true};
 });
}
export async function renderStoredPreview(outDir,ctx,{fps=15,exportVideo=true}={}){
 const tl=JSON.parse(fs.readFileSync(path.join(outDir,'timeline.json'),'utf8'));
 if(!Number.isFinite(tl.duration)||tl.duration<=0||tl.duration>240)fail('LESSON_TOO_LONG');
 if(!Number.isInteger(fps)||fps<1||fps>30)fail('RENDER_FAILED');
 const tmp=exportVideo?fs.mkdtempSync(path.join(os.tmpdir(),'tutor-frames-')):null;
 try{return await withBrowser(ctx.signal,launchBrowser,async browser=>{
  const page=await openArtifact(browser,outDir);
  await page.waitForFunction(()=>!!globalThis.SV?.state||typeof globalThis.renderFrame==='function',undefined,{timeout:15000});
  const mode=await page.evaluate(()=>globalThis.SV?.state?'board':'animation');
  if(mode==='board'){
   await page.evaluate(()=>SV.state().ready);
   if((await page.evaluate(()=>SV.report())).length)fail('INVALID_LESSON');
  }else await page.evaluate(async()=>{if(globalThis.ready)await globalThis.ready;});
  const seek=t=>page.evaluate(({t,mode})=>mode==='board'?SV.seek(t):globalThis.renderFrame(t),{t,mode});
  if(exportVideo){
   const n=Math.ceil(tl.duration*fps);
   for(let i=0;i<n;i++){ctx.guard();await seek(i/fps);await page.screenshot({path:path.join(tmp,String(i).padStart(5,'0')+'.jpg'),type:'jpeg',quality:86});}
  }
  ctx.guard();await seek(Math.max(0,tl.duration-1));if(page.artifactErrors.length)fail('RENDER_FAILED');await page.screenshot({path:path.join(outDir,'cover.png')});
  if(exportVideo){
   await runProcess(process.env.FFMPEG||'ffmpeg',['-v','error','-y','-framerate',String(fps),'-i',path.join(tmp,'%05d.jpg'),'-i',path.join(outDir,'audio.wav'),'-c:v','libx264','-preset','fast','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-b:a','96k','-shortest','-movflags','+faststart',path.join(outDir,'video.mp4')],{signal:ctx.signal});
  }
  ctx.guard();return {duration:tl.duration,segments:tl.segments||tl.scenes.map(s=>({title:s.title,at:s.at??s.start})),videoReady:exportVideo,previewReady:true,subtitlesReady:true,coverReady:true};
 });}finally{if(tmp)fs.rmSync(tmp,{recursive:true,force:true});}
}
export async function renderLesson(lesson,clips,outDir,ctx,options={}){
 ctx.guard();const timeline=compile(expandIntro(lesson),clips);
 if(timeline.warnings.length)fail('INVALID_FORMULA');if(timeline.duration>240)fail('LESSON_TOO_LONG');
 timeline.captions=timeline.captions.flatMap(c=>{
  const chars=Array.from(c.text),chunks=[];for(let i=0;i<chars.length;i+=26){const count=Math.min(26,chars.length-i);chunks.push({...c,text:chars.slice(i,i+count).join(''),at:c.at+(c.end-c.at)*i/chars.length,end:c.at+(c.end-c.at)*(i+count)/chars.length,words:[]});}return chunks;
 });
 await mixTimelineAudio(timeline,outDir,ctx);
 let html=makePage({...timeline,audio:[]});
 html=html.replace('</head>','<style>body,.stage,.ln,.ct{font-family:"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif!important}.stage.nofig .col{font-size:80px;line-height:1.4}.stage.nofig .ln.title{font-size:52px}.stage.nofig .cap{font-size:40px;max-width:1180px}</style></head>');
 fs.writeFileSync(path.join(outDir,'preview.html'),html);fs.writeFileSync(path.join(outDir,'timeline.json'),JSON.stringify(timeline));fs.writeFileSync(path.join(outDir,'subtitles.srt'),toSrt(timeline.captions));
 await publicPreview(outDir,'math-video',ctx);
 return renderStoredPreview(outDir,ctx,options);
}
