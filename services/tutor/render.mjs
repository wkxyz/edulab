import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';import {createRequire} from 'node:module';import {spawn} from 'node:child_process';
import {compile,expandIntro,toSrt} from '../../skills/edu-math-video/lesson/scripts/compile.mjs';
import {makePage} from '../../skills/edu-math-video/lesson/scripts/build.mjs';
import {fail} from './validation.mjs';
import {withBrowser} from './browser-session.mjs';
const require=createRequire(import.meta.url);const HERE=path.dirname(fileURLToPath(import.meta.url));
export function runProcess(command,args,{signal,cwd,maxBytes=32*1024*1024}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{cwd,signal,stdio:['ignore','pipe','pipe']});const chunks=[];let size=0,stderr='';
  child.stdout.on('data',b=>{size+=b.length;if(size>maxBytes){child.kill();return;}chunks.push(b);});
  child.stderr.on('data',b=>{if(stderr.length<2000)stderr+=b.toString();});
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
export async function renderLesson(lesson,clips,outDir,ctx,{fps=15,scale=1}={}){
 ctx.guard();const expanded=expandIntro(lesson);const timeline=compile(expanded,clips);
 if(timeline.warnings.length)fail('INVALID_FORMULA');
 if(timeline.duration>240)fail('LESSON_TOO_LONG');
 const sr=24000,pcm=new Int16Array(Math.ceil(timeline.duration*sr));
 for(const clip of timeline.audio){ctx.guard();const raw=await runProcess(process.env.FFMPEG||'ffmpeg',['-v','error','-i',clip.file,'-f','s16le','-ac','1','-ar','24000','-'],{signal:ctx.signal});const src=new Int16Array(raw.buffer,raw.byteOffset,raw.length/2);let off=Math.round(clip.at*sr);for(let i=0;i<src.length&&off+i<pcm.length;i++)pcm[off+i]=src[i];}
 const header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(36+pcm.byteLength,4);header.write('WAVE',8);header.write('fmt ',12);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(sr,24);header.writeUInt32LE(sr*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.byteLength,40);
 fs.writeFileSync(path.join(outDir,'audio.wav'),Buffer.concat([header,Buffer.from(pcm.buffer)]));
 let html=makePage(timeline);
 try{const dist=path.dirname(require.resolve('katex/dist/katex.min.js'));html=html.replaceAll(/file:\/\/[^"\s]*\/node_modules\/katex\/dist\//g,pathToFileURL(dist+'/').href);}catch{if(ctx.live)fail('RENDER_FAILED');}
 html=html.replace(/<link rel="stylesheet" href="(file:[^"]+)"[^>]*>/g,(tag,url)=>fs.existsSync(fileURLToPath(url))?tag:'');
 html=html.replace('</head>','<style>body,.stage,.ln,.ct{font-family:"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif!important}</style></head>');
 fs.writeFileSync(path.join(outDir,'preview.html'),html);fs.writeFileSync(path.join(outDir,'timeline.json'),JSON.stringify(timeline));fs.writeFileSync(path.join(outDir,'subtitles.srt'),toSrt(timeline.captions));
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'tutor-frames-'));
 try{return await withBrowser(ctx.signal,()=>chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE?{executablePath:process.env.CHROMIUM_EXECUTABLE}:{})}),async browser=>{
  const page=await browser.newPage({viewport:{width:1280,height:720},deviceScaleFactor:scale});
  await page.goto(pathToFileURL(path.join(outDir,'preview.html')).href+'?mode=render');
  await page.waitForFunction(()=>!!globalThis.SV?.state());await page.evaluate(()=>SV.state().ready);
  const n=Math.ceil(timeline.duration*fps);
  for(let i=0;i<n;i++){ctx.guard();await page.evaluate(t=>SV.seek(t),i/fps);await page.screenshot({path:path.join(tmp,`${String(i).padStart(5,'0')}.jpg`),type:'jpeg',quality:86});}
  ctx.guard();await page.evaluate(t=>SV.seek(t),timeline.duration-1);await page.screenshot({path:path.join(outDir,'cover.png')});
  await runProcess(process.env.FFMPEG||'ffmpeg',['-v','error','-y','-framerate',String(fps),'-i',path.join(tmp,'%05d.jpg'),'-i',path.join(outDir,'audio.wav'),'-c:v','libx264','-preset','fast','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-b:a','96k','-shortest','-movflags','+faststart',path.join(outDir,'video.mp4')],{signal:ctx.signal});
  ctx.guard();return {duration:timeline.duration,segments:timeline.scenes.map(s=>({title:s.title,at:s.at}))};
 });}finally{fs.rmSync(tmp,{recursive:true,force:true});}
}
