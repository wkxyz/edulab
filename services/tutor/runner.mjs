import fs from 'node:fs';import path from 'node:path';
import {sampleLesson} from './sample.mjs';import {animationSample} from './capability-samples.mjs';
import {solve,solveStructured,glmSpeech} from './ai.mjs';
import {renderLesson,narrateOffline,duration,mixTimelineAudio,publicPreview,renderStoredPreview,captureInteractiveCover} from './render.mjs';
import {expandIntro} from '../../skills/edu-math-video/lesson/scripts/compile.mjs';
import {validateLesson,fail} from './validation.mjs';
import {kieSpeech} from './kie.mjs';import {minimaxSpeech} from './minimax.mjs';
import {interactiveInstructions,buildInteractive} from './interactive.mjs';
import {animationInstructions,validateAnimation,buildAnimatedPreview} from './animated-video.mjs';
import {getCapability} from '../../apps/web/capabilities.mjs';

function safeStoredJSON(file){
 try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{fail('ARTIFACT_EXPIRED');}
}
export function createRunner(config){return async(task,ctx)=>{
 ctx.live=task.mode==='live';ctx.guard();const out=path.join(config.dataDir,'jobs',task.id);fs.mkdirSync(out,{recursive:true});
 const capability=task.input.capability||'math-video',entry=getCapability(capability),sample=task.mode==='sample';
 const options={...config.renderOptions,exportVideo:task.input.exportVideo!==false};
 try{
  if(task.mode==='export'){
   const source=task.input.exportOf;if(!/^[a-f0-9-]{36}$/.test(source))fail('EXPORT_NOT_AVAILABLE');
   const from=path.join(config.dataDir,'jobs',source);
   for(const name of ['preview.html','lesson.html','audio.wav','timeline.json','subtitles.srt']){
    const file=path.join(from,name);let stat;try{stat=fs.lstatSync(file);}catch{fail('ARTIFACT_EXPIRED');}
    if(!stat.isFile()||stat.size>40*1024*1024)fail('ARTIFACT_EXPIRED');fs.copyFileSync(file,path.join(out,name));ctx.guard();
   }
   ctx.stage('rendering');const rendered=await renderStoredPreview(out,ctx,{...config.renderOptions,exportVideo:true});
   return {...task.input.sourceResult,...rendered,format:'video',exportOf:source};
  }
  if(entry.kind==='interactive'){
   let result;
   if(sample){ctx.stage('checking');result=await buildInteractive(capability,null,out,ctx,{sampleId:task.input.sampleId==='random'?'random':'default'});}
   else{
    const solved=await solveStructured(task.input,config,ctx,{instructions:interactiveInstructions(capability),
     materialize:spec=>buildInteractive(capability,spec,out,ctx,task.input.text?{originalText:task.input.text}:{})});
    result=solved.result;
   }
   ctx.stage('rendering');await publicPreview(out,capability,ctx);
   const cover=await captureInteractiveCover(out,ctx);
   return {...result,...cover,previewReady:true,disclosure:sample?(task.input.sampleId==='random'?'内置题型随机练习':'内置固定示例'):'AI 识题与独立复核，精确内核计算；仅供学习参考'};
  }
  const animated=capability!=='math-video'||task.input.style==='handdrawn';
  let lesson;
  if(sample){lesson=animated?validateAnimation(animationSample(capability),capability):validateLesson(structuredClone(sampleLesson));if(!animated)lesson.meta.style=task.input.style;ctx.stage('checking');}
  else if(animated){lesson=(await solveStructured(task.input,config,ctx,{instructions:animationInstructions(capability),validate:value=>validateAnimation(value,capability)})).spec;}
  else lesson=await solve(task.input,config,ctx);
  ctx.guard();fs.writeFileSync(path.join(out,'lesson.json'),JSON.stringify(lesson,null,2));
  ctx.stage('voicing');const clips=[];
  const lines=animated?lesson.scenes.flatMap(s=>s.lines).map(l=>l.tts):expandIntro(lesson).scenes.flatMap(s=>s.beats).map(b=>b.speak||b.say);
  for(let i=0;i<lines.length;i++){
   ctx.guard();const file=path.join(out,'speech-'+i+'.wav'),text=lines[i];
   if(sample)await narrateOffline(text,file,ctx);
   else if(config.ttsProvider==='minimax')await minimaxSpeech(text,file,config,ctx);
   else if(config.ttsProvider==='kie')await kieSpeech(text,file,config,ctx);
   else await glmSpeech(text,file,config,ctx);
   const seconds=await duration(file,ctx.signal);if(!Number.isFinite(seconds)||seconds<=0||seconds>45)fail('INVALID_LESSON');
   clips.push({file,duration:seconds,words:[]});
  }
  ctx.stage('rendering');let result;
  if(animated){
   const meta=await buildAnimatedPreview(lesson,clips,out,ctx);
   await mixTimelineAudio(safeStoredJSON(path.join(out,'timeline.json')),out,ctx);
   await publicPreview(out,capability,ctx);result={...meta,...await renderStoredPreview(out,ctx,options)};
  }else{
   result={title:lesson.meta.title,problem:lesson.meta.problem,answer:lesson.meta.answer,
    steps:lesson.scenes.map(s=>({title:s.goal,description:s.beats.map(b=>b.say).join('')})),
    ...await renderLesson(lesson,clips,out,ctx,options)};
  }
  return {...result,format:'video',disclosure:sample?'固定示例，离线配音':'AI 生成讲解，仅供学习参考'};
 }catch(e){fs.rmSync(out,{recursive:true,force:true});throw e;}
};}
