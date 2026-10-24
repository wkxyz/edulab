import fs from 'node:fs';import path from 'node:path';
import {sampleLesson} from './sample.mjs';import {solve,glmSpeech} from './ai.mjs';
import {renderLesson,narrateOffline,duration} from './render.mjs';
import {expandIntro} from '../../skills/edu-math-video/lesson/scripts/compile.mjs';
import {validateLesson} from './validation.mjs';
import {kieSpeech} from './kie.mjs';import {minimaxSpeech} from './minimax.mjs';
export function createRunner(config){return async(task,ctx)=>{
 ctx.live=task.mode==='live';ctx.guard();const out=path.join(config.dataDir,'jobs',task.id);fs.mkdirSync(out,{recursive:true});
 try{
  let lesson;
  if(task.mode==='sample'){lesson=structuredClone(sampleLesson);lesson.meta.style=task.input.style;ctx.stage('checking');}
  else lesson=await solve(task.input,config,ctx);
  lesson=validateLesson(lesson);ctx.guard();fs.writeFileSync(path.join(out,'lesson.json'),JSON.stringify(lesson,null,2));
  ctx.stage('voicing');const clips=[],beats=expandIntro(lesson).scenes.flatMap(s=>s.beats);
  for(let i=0;i<beats.length;i++){
   ctx.guard();const file=path.join(out,`speech-${i}.wav`),text=beats[i].speak||beats[i].say;
   if(task.mode==='sample')await narrateOffline(text,file,ctx);else if(config.ttsProvider==='minimax')await minimaxSpeech(text,file,config,ctx);else if(config.ttsProvider==='kie')await kieSpeech(text,file,config,ctx);else await glmSpeech(text,file,config,ctx);
   const seconds=await duration(file,ctx.signal);if(!Number.isFinite(seconds)||seconds<=0||seconds>45)throw new Error('BAD_AUDIO');clips.push({file,duration:seconds,words:[]});
  }
  ctx.stage('rendering');const rendered=await renderLesson(lesson,clips,out,ctx,config.renderOptions);
  return {title:lesson.meta.title,problem:lesson.meta.problem,answer:lesson.meta.answer,steps:lesson.scenes.map(s=>({title:s.goal,description:s.beats.map(b=>b.say).join('')})),...rendered,disclosure:task.mode==='sample'?'固定示例，离线配音':'AI 生成讲解，仅供学习参考'};
 }catch(e){fs.rmSync(out,{recursive:true,force:true});throw e;}
};}
