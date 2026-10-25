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
import {readFixedArtifact,readSourceLesson,copyExportArtifacts,interactiveNarrationPlan,STAGED_CAPABILITIES} from './lesson-stages.mjs';
import {buildNarratedBoard} from './narrated-board.mjs';

function timeline(out){try{return JSON.parse(readFixedArtifact(out,'timeline.json',256*1024).toString('utf8'));}catch{fail('ARTIFACT_EXPIRED');}}
function speechLines(lesson,animated){return animated?lesson.scenes.flatMap(s=>s.lines).map(l=>l.tts):expandIntro(lesson).scenes.flatMap(s=>s.beats).map(b=>b.speak||b.say);}
// Adapters allow offline orchestration tests to count provider calls without
// contacting a model, synthesizer, or browser.
export function createRunner(config,adapters={}){
 const api={solve,solveStructured,glmSpeech,kieSpeech,minimaxSpeech,narrateOffline,duration,renderLesson,mixTimelineAudio,publicPreview,renderStoredPreview,captureInteractiveCover,buildInteractive,buildAnimatedPreview,buildNarratedBoard,...adapters};
 async function voice(lines,out,ctx,sample){
  if(!Array.isArray(lines)||!lines.length||lines.length>12||lines.some(text=>typeof text!=='string'||!text.trim()||text.length>160))fail('INVALID_LESSON');
  ctx.stage('voicing');const clips=[];
  for(const [i,text] of lines.entries()){
   ctx.guard();const file=path.join(out,'speech-'+i+'.wav');
   if(sample)await api.narrateOffline(text,file,ctx);
   else if(config.ttsProvider==='minimax')await api.minimaxSpeech(text,file,config,ctx);
   else if(config.ttsProvider==='kie')await api.kieSpeech(text,file,config,ctx);
   else await api.glmSpeech(text,file,config,ctx);
   ctx.guard();const seconds=await api.duration(file,ctx.signal);
   if(!Number.isFinite(seconds)||seconds<=0||seconds>45)fail('INVALID_LESSON');
   clips.push({file,duration:seconds,words:[]});
  }
  return clips;
 }
 async function preview(lesson,animated,clips,out,ctx,capability,options){
  ctx.stage('rendering');
  if(animated){
   const meta=await api.buildAnimatedPreview(lesson,clips,out,ctx,{narration:options.narration});
   if(options.narration)await api.mixTimelineAudio(timeline(out),out,ctx);
   await api.publicPreview(out,capability,ctx);
   return {...meta,...await api.renderStoredPreview(out,ctx,options)};
  }
  return {title:lesson.meta.title,problem:lesson.meta.problem,answer:lesson.meta.answer,
   steps:lesson.scenes.map(s=>({title:s.goal,description:s.beats.map(b=>b.say).join('')})),
   ...await api.renderLesson(lesson,clips,out,ctx,options)};
 }
 return async(task,ctx)=>{
  ctx.live=task.mode==='live'||task.mode==='narration'&&task.input.sourceMode==='live';ctx.guard();
  if((task.mode==='narration'&&task.id===task.input.narrationOf)||(task.mode==='export'&&task.id===task.input.exportOf))fail('ARTIFACT_EXPIRED');
  const out=path.join(config.dataDir,'jobs',task.id);fs.mkdirSync(out,{recursive:true});
  const capability=task.input.capability||'math-video',entry=getCapability(capability),sample=task.mode==='sample';
  try{
   if(task.mode==='export'){
    copyExportArtifacts(config,task.input,out,ctx);ctx.stage('rendering');
    const rendered=await api.renderStoredPreview(out,ctx,{...config.renderOptions,narration:true,exportVideo:true});
    return {...task.input.sourceResult,...rendered,format:'video',audioReady:true,exportOf:task.input.exportOf};
   }
   if(task.mode==='narration'){
    const source=readSourceLesson(config,task.input,ctx),sourceCapability=task.input.sourceCapability;
    if(capability!==STAGED_CAPABILITIES[sourceCapability])fail('INVALID_CAPABILITY');
    // Preserve the exact checked source bytes; subsequent stages never rewrite
    // or regenerate the original question, answer, or lesson.
    fs.writeFileSync(path.join(out,'lesson.json'),source.bytes);ctx.stage('checking');
    const options={...config.renderOptions,narration:true,exportVideo:false};
    let result;
    if(source.lesson.format==='interactive'){
     if(!['solid-geometry','analytic-geometry','chem-reaction'].includes(sourceCapability))fail('ARTIFACT_EXPIRED');
     const plan=interactiveNarrationPlan(source.lesson),clips=await voice(plan.sections.map(s=>s.say),out,ctx,task.input.sourceMode==='sample');
     ctx.stage('rendering');result=await api.buildNarratedBoard(plan,clips,out,ctx,options);
    }else{
     if(!['math-video','physics-video','chem-video'].includes(sourceCapability))fail('ARTIFACT_EXPIRED');
     const animated=sourceCapability!=='math-video'||Array.isArray(source.lesson.scenes?.[0]?.lines);
     const lesson=animated?validateAnimation(source.lesson,sourceCapability):validateLesson(source.lesson);
     const clips=await voice(speechLines(lesson,animated),out,ctx,task.input.sourceMode==='sample');
     result=await preview(lesson,animated,clips,out,ctx,capability,options);
    }
    return {...result,format:'video',audioReady:true,videoReady:false,narrationOf:task.input.narrationOf,disclosure:task.input.sourceMode==='sample'?'已核对讲解，离线示例配音':'复用已核对讲解生成配音，仅供学习参考'};
   }
   if(entry.kind==='interactive'){
    let result;
    if(sample){ctx.stage('checking');result=await api.buildInteractive(capability,null,out,ctx,{sampleId:task.input.sampleId==='random'?'random':'default'});}
    else{
     const solved=await api.solveStructured(task.input,config,ctx,{instructions:interactiveInstructions(capability),
      materialize:spec=>api.buildInteractive(capability,spec,out,ctx,task.input.text?{originalText:task.input.text}:{})});
     result=solved.result;
    }
    ctx.stage('rendering');await api.publicPreview(out,capability,ctx);
    const cover=await api.captureInteractiveCover(out,ctx);
    return {...result,...cover,format:'interactive',audioReady:false,videoReady:false,subtitlesReady:false,previewReady:true,
     disclosure:sample?(task.input.sampleId==='random'?'内置题型随机练习':'内置固定示例'):'AI 识题与独立复核，精确内核计算；仅供学习参考'};
   }
   const animated=capability!=='math-video'||task.input.style==='handdrawn';
   let lesson;
   if(sample){lesson=animated?validateAnimation(animationSample(capability),capability):validateLesson(structuredClone(sampleLesson));if(!animated)lesson.meta.style=task.input.style||lesson.meta.style;ctx.stage('checking');}
   else if(animated){lesson=(await api.solveStructured(task.input,config,ctx,{instructions:animationInstructions(capability),validate:value=>validateAnimation(value,capability)})).spec;}
   else lesson=await api.solve(task.input,config,ctx);
   ctx.guard();fs.writeFileSync(path.join(out,'lesson.json'),JSON.stringify(lesson,null,2));
   const narration=task.input.delivery==='video',options={...config.renderOptions,narration,exportVideo:narration&&task.input.exportVideo!==false};
   const clips=narration?await voice(speechLines(lesson,animated),out,ctx,sample):[];
   const result=await preview(lesson,animated,clips,out,ctx,capability,options);
   return {...result,format:narration?'video':'lesson',audioReady:narration,subtitlesReady:narration,
    disclosure:sample?(narration?'固定示例，离线配音':'内置固定示例，无配音讲解'):'AI 生成并独立复核的讲解，仅供学习参考'};
  }catch(e){fs.rmSync(out,{recursive:true,force:true});throw e;}
 };
}
