import fs from 'node:fs';
import path from 'node:path';
import {fail} from './validation.mjs';

export const STAGED_CAPABILITIES=Object.freeze({
 'math-video':'math-video','physics-video':'physics-video','chem-video':'chem-video',
 'solid-geometry':'math-video','analytic-geometry':'math-video','chem-reaction':'chem-video'
});
const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const FILES=new Set(['lesson.json','preview.html','lesson.html','audio.wav','timeline.json','subtitles.srt']);
export function sourceDirectory(config,id){
 if(typeof id!=='string'||!ID.test(id))fail('ARTIFACT_EXPIRED');
 const dir=path.join(config.dataDir,'jobs',id);
 let stat;try{stat=fs.lstatSync(dir);}catch{fail('ARTIFACT_EXPIRED');}
 if(!stat.isDirectory()||stat.isSymbolicLink())fail('ARTIFACT_EXPIRED');
 return dir;
}
// Read only fixed filenames with O_NOFOLLOW and a bounded read. Model data never
// becomes a path, executable code, dependency URL, or browser script.
export function readFixedArtifact(dir,name,maxBytes=40*1024*1024){
 if(!FILES.has(name))fail('ARTIFACT_EXPIRED');
 const file=path.join(dir,name);let fd;
 try{
  const before=fs.lstatSync(file);if(!before.isFile()||before.isSymbolicLink()||before.size<1||before.size>maxBytes)fail('ARTIFACT_EXPIRED');
  fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size!==before.size||stat.ino!==before.ino||stat.dev!==before.dev)fail('ARTIFACT_EXPIRED');
  const bytes=Buffer.alloc(stat.size+1);let n=0;
  while(n<bytes.length){const count=fs.readSync(fd,bytes,n,bytes.length-n,n);if(!count)break;n+=count;}
  if(n!==stat.size)fail('ARTIFACT_EXPIRED');return bytes.subarray(0,n);
 }catch(e){if(e?.code==='ARTIFACT_EXPIRED')throw e;fail('ARTIFACT_EXPIRED');}
 finally{if(fd!==undefined)fs.closeSync(fd);}
}
export function readSourceLesson(config,input,ctx){
 if(!['sample','live'].includes(input.sourceMode)||!Object.hasOwn(STAGED_CAPABILITIES,input.sourceCapability))fail('ARTIFACT_EXPIRED');
 const dir=sourceDirectory(config,input.narrationOf),bytes=readFixedArtifact(dir,'lesson.json',256*1024);
 ctx.guard();let lesson;try{lesson=JSON.parse(bytes.toString('utf8'));}catch{fail('ARTIFACT_EXPIRED');}
 if(!lesson||typeof lesson!=='object'||Array.isArray(lesson))fail('ARTIFACT_EXPIRED');
 return {dir,bytes,lesson};
}
export function copyExportArtifacts(config,input,out,ctx){
 if(input.sourceResult?.audioReady!==true||input.sourceResult?.format!=='video')fail('EXPORT_NOT_AVAILABLE');
 const from=sourceDirectory(config,input.exportOf);
 for(const name of ['preview.html','lesson.html','audio.wav','timeline.json','subtitles.srt']){
  ctx.guard();const bytes=readFixedArtifact(from,name);
  if(name==='audio.wav'&&(bytes.length<44||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE'))fail('ARTIFACT_EXPIRED');
  fs.writeFileSync(path.join(out,name),bytes);
 }
 ctx.guard();return from;
}
const checkedText=(value,max)=>{if(typeof value!=='string'||!value.trim()||value.length>max||value.includes('\0'))fail('ARTIFACT_EXPIRED');return value;};
export function safeNarrationText(text){
 // Never pronounce arbitrary TeX, ratios, conditions, or truncated equations.
 // Full checked text is kept on screen; only short, plain prose is spoken.
 if(typeof text!=='string'||Array.from(text).length>130||!text.trim()||!/^([\p{Script=Han}0-9０-９\s，。、；：！？,.!?（）()“”‘’—-])+$/u.test(text))return '推导请看屏幕。';
 return text;
}
export function interactiveNarrationPlan(value){
 if(value?.format!=='interactive'||!Array.isArray(value.steps)||!value.steps.length||value.steps.length>8)fail('ARTIFACT_EXPIRED');
 const meta={title:checkedText(value.title,1000),problem:checkedText(value.problem,10000),answer:checkedText(value.answer,10000)};
 const steps=value.steps.map(step=>({title:checkedText(step?.title,1000),description:checkedText(step?.description,15000)}));
 if(JSON.stringify({meta,steps}).length>80000)fail('ARTIFACT_EXPIRED');
 const sections=[
  {title:'题目与全部条件',text:meta.problem,say:'请看屏幕上的完整题目和全部条件。'},
  ...steps.map((step,i)=>({title:step.title,text:step.description,say:'第'+(i+1)+'步。'+safeNarrationText(step.description)})),
  {title:'已核对答案',text:meta.answer,say:'已核对的最终答案请看屏幕。'}
 ];
 return {meta,steps,sections};
}
