import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import vm from 'node:vm';
import {createRunner} from '../runner.mjs';
import {sampleLesson} from '../sample.mjs';
import {animationSample} from '../capability-samples.mjs';
import {validateLesson} from '../validation.mjs';
import {validateAnimation,buildAnimatedPreview} from '../animated-video.mjs';
import {sourceDirectory,readFixedArtifact,readSourceLesson,copyExportArtifacts,interactiveNarrationPlan,safeNarrationText} from '../lesson-stages.mjs';
import {compileNarratedBoard,makeNarratedBoardPage} from '../narrated-board.mjs';
import {makeStandalonePreview} from '../artifact-assets.mjs';

const capabilities=['math-video','physics-video','chem-video','solid-geometry','analytic-geometry','chem-reaction'];
const interactive=()=>({format:'interactive',title:'已核对的空间几何',problem:'保留全部原题条件：正方体棱长为二，点 E 为 AB 中点，求点到平面的距离。',answer:'\\frac{2\\sqrt{22}}{11}',steps:[
 {title:'建立空间坐标系',description:'先根据题设建立空间坐标系，再写出各顶点坐标。'},
 {title:'求法向量并计算距离',description:'利用 $\\vec n=(1,2,3)$ 求法向量。完整计算为 $d=\\frac{2\\sqrt{22}}{11}$。保留条件：E 为 AB 中点。'}
],data:{checked:true}});
function wav(){const b=Buffer.alloc(48);b.write('RIFF');b.writeUInt32LE(40,4);b.write('WAVE',8);b.write('fmt ',12);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(4,40);return b;}
function context(){return {live:false,signal:new AbortController().signal,stages:[],guard(){if(this.cancelled)throw new Error('CANCELLED');},stage(s){this.stages.push(s);}};}
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lesson-stages-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const calls={solve:0,structured:0,offline:[],paid:[],mix:0,render:[],boards:[]};
 const unavailable=()=>{throw new Error('UNEXPECTED_REAL_PROVIDER');};
 const adapters={
  solve:unavailable,solveStructured:unavailable,
  glmSpeech:unavailable,kieSpeech:unavailable,minimaxSpeech:unavailable,
  narrateOffline:async(text,file)=>{calls.offline.push({text,file});fs.writeFileSync(file,wav());},
  duration:async()=>2,
  publicPreview:async()=>{},
  captureInteractiveCover:async()=>({coverReady:true}),
  buildInteractive:async(_cap,_spec,out)=>{const lesson=interactive();fs.writeFileSync(path.join(out,'lesson.json'),JSON.stringify(lesson));fs.writeFileSync(path.join(out,'preview.html'),'<canvas></canvas>');return lesson;},
  renderLesson:async(lesson,clips,out,_ctx,options)=>{
   calls.render.push({kind:'board',clips,options});fs.writeFileSync(path.join(out,'preview.html'),'<div id="stage"></div>');
   fs.writeFileSync(path.join(out,'timeline.json'),JSON.stringify({duration:5,audio:[],scenes:[]}));
   return {previewEngine:'board',videoReady:options.exportVideo,previewReady:true,coverReady:true,audioReady:options.narration,subtitlesReady:options.narration};
  },
  mixTimelineAudio:async(_timeline,out)=>{calls.mix++;fs.writeFileSync(path.join(out,'audio.wav'),wav());},
  renderStoredPreview:async(_out,_ctx,options)=>{calls.render.push({kind:'stored',options});return {previewEngine:'animation',videoReady:options.exportVideo,previewReady:true,coverReady:true,audioReady:options.narration,subtitlesReady:options.narration};},
  buildNarratedBoard:async(plan,clips,_out,_ctx,options)=>{calls.boards.push({plan,clips,options});return {title:plan.meta.title,problem:plan.meta.problem,answer:plan.meta.answer,steps:plan.steps,previewEngine:'board',previewReady:true,subtitlesReady:true};}
 };
 const config={dataDir:dir,ttsProvider:'minimax',renderOptions:{fps:1}};
 return {dir,config,calls,adapters,runner:()=>createRunner(config,adapters)};
}
function stored(x,lesson){
 const id=randomUUID(),dir=path.join(x.dir,'jobs',id);fs.mkdirSync(dir,{recursive:true});
 const bytes=Buffer.from(JSON.stringify(lesson,null,3)+'\n');fs.writeFileSync(path.join(dir,'lesson.json'),bytes);
 return {id,dir,bytes};
}
function task(mode,input){return {id:randomUUID(),mode,input};}
function narration(source,sourceCapability,sourceMode='sample'){
 const capability=sourceCapability==='chem-reaction'?'chem-video':['solid-geometry','analytic-geometry'].includes(sourceCapability)?'math-video':sourceCapability;
 return task('narration',{narrationOf:source.id,sourceMode,sourceCapability,capability,delivery:'video',exportVideo:false,sourceResult:{format:sourceCapability.endsWith('geometry')||sourceCapability==='chem-reaction'?'interactive':'lesson',audioReady:false}});
}

test('all six default lesson capabilities invoke zero speech providers and zero MP4 renders',async t=>{
 const x=fixture(t),run=x.runner();
 for(const capability of capabilities){
  const job=task('sample',{capability,sampleId:'default',delivery:'lesson',style:'whiteboard'});
  const result=await run(job,context()),out=path.join(x.dir,'jobs',job.id);
  assert.equal(result.format,['solid-geometry','analytic-geometry','chem-reaction'].includes(capability)?'interactive':'lesson');
  assert.equal(result.audioReady,false);assert.equal(result.videoReady,false);assert.equal(result.subtitlesReady,false);
  for(const file of ['audio.wav','subtitles.srt','video.mp4','speech-0.wav'])assert.equal(fs.existsSync(path.join(out,file)),false,capability+' created '+file);
  assert.ok(fs.existsSync(path.join(out,'lesson.json')));
 }
 assert.equal(x.calls.offline.length,0);assert.equal(x.calls.paid.length,0);assert.equal(x.calls.mix,0);
 assert.ok(x.calls.render.every(r=>r.options.narration===false&&r.options.exportVideo===false));
});

test('actual silent animation builders omit WAV references, SRT and media files',async t=>{
 const x=fixture(t);
 for(const capability of ['math-video','physics-video','chem-video']){
  const out=path.join(x.dir,capability);const result=await buildAnimatedPreview(validateAnimation(animationSample(capability),capability),[],out,context(),{narration:false});
  assert.equal(result.format,'lesson');assert.equal(result.audioReady,false);
  const tl=JSON.parse(fs.readFileSync(path.join(out,'timeline.json'),'utf8'));
  assert.deepEqual(tl.audio,[]);assert.ok(tl.duration>0&&tl.duration<=240);
  const html=fs.readFileSync(path.join(out,'preview.html'),'utf8');
  assert.match(html,/<audio id="au" preload="metadata"><\/audio>/);assert.doesNotMatch(html,/<audio[^>]+src=/);
  assert.equal(fs.existsSync(path.join(out,'subtitles.srt')),false);assert.equal(fs.existsSync(path.join(out,'audio.wav')),false);
 }
});

test('explicit and legacy video inputs retain speech-i ordering and offline delivery',async t=>{
 const x=fixture(t),run=x.runner();
 for(const delivery of ['video',undefined]){
  const start=x.calls.offline.length,job=task('sample',{capability:'math-video',style:'whiteboard',...(delivery?{delivery}:{}),exportVideo:false});
  const result=await run(job,context()),voices=x.calls.offline.slice(start);
  assert.equal(result.format,'video');assert.equal(result.audioReady,true);assert.equal(result.videoReady,false);
  assert.equal(voices.length,4);assert.match(voices[0].text,/解方程/);
  voices.forEach((v,i)=>assert.equal(path.basename(v.file),'speech-'+i+'.wav'));
 }
});

test('all three video sources reuse exact checked bytes and never solve during narration',async t=>{
 const x=fixture(t),run=x.runner();
 for(const capability of ['math-video','physics-video','chem-video']){
  const value=capability==='math-video'?validateLesson(structuredClone(sampleLesson)):validateAnimation(animationSample(capability),capability);
  const source=stored(x,value),job=narration(source,capability),before=x.calls.offline.length;
  const result=await run(job,context());
  assert.deepEqual(fs.readFileSync(path.join(source.dir,'lesson.json')),source.bytes);
  assert.deepEqual(fs.readFileSync(path.join(x.dir,'jobs',job.id,'lesson.json')),source.bytes);
  assert.equal(result.problem,value.meta.problem);assert.equal(result.answer,value.meta.answer);
  assert.equal(result.format,'video');assert.equal(result.audioReady,true);assert.equal(result.videoReady,false);
  assert.ok(x.calls.offline.length>before);assert.equal(result.narrationOf,source.id);
 }
 assert.ok(x.calls.render.every(r=>r.options.exportVideo===false));
});

test('three interactive capabilities deterministically narrate exact problem, answer and full steps',async t=>{
 const x=fixture(t),run=x.runner();
 for(const capability of ['solid-geometry','analytic-geometry','chem-reaction']){
  const original=interactive(),source=stored(x,original),job=narration(source,capability),ctx=context();
  const result=await run(job,ctx),board=x.calls.boards.at(-1);
  assert.equal(result.problem,original.problem);assert.equal(result.answer,original.answer);assert.deepEqual(result.steps,original.steps);
  assert.equal(result.previewEngine,'board');assert.equal(result.videoReady,false);assert.equal(result.audioReady,true);
  assert.deepEqual(fs.readFileSync(path.join(source.dir,'lesson.json')),source.bytes);
  assert.deepEqual(fs.readFileSync(path.join(x.dir,'jobs',job.id,'lesson.json')),source.bytes);
  assert.deepEqual(board.plan.sections.slice(1,-1).map(s=>s.text),original.steps.map(s=>s.description));
  assert.ok(board.clips.length<=12);assert.ok(board.plan.sections.every(s=>s.say.length<=160));
  assert.equal(ctx.live,false);
 }
});

test('live-source narration counts only TTS, keeps ctx.live and never resolves the source',async t=>{
 const x=fixture(t),source=stored(x,validateLesson(structuredClone(sampleLesson)));
 x.adapters.minimaxSpeech=async(text,file,_config,ctx)=>{assert.equal(ctx.live,true);x.calls.paid.push(text);fs.writeFileSync(file,wav());};
 const ctx=context(),result=await x.runner()(narration(source,'math-video','live'),ctx);
 assert.equal(ctx.live,true);assert.equal(x.calls.paid.length,4);assert.equal(x.calls.offline.length,0);assert.equal(result.videoReady,false);
 assert.deepEqual(fs.readFileSync(path.join(source.dir,'lesson.json')),source.bytes);
});

test('narration rejects excess clips, invalid duration and cancellation without touching source',async t=>{
 const x=fixture(t),lesson=validateLesson(structuredClone(sampleLesson)),source=stored(x,lesson),ctx=context();
 x.adapters.narrateOffline=async(text,file)=>{x.calls.offline.push(text);fs.writeFileSync(file,wav());ctx.cancelled=true;};
 const job=narration(source,'math-video');
 await assert.rejects(()=>x.runner()(job,ctx),/CANCELLED/);assert.equal(x.calls.offline.length,1);
 assert.equal(fs.existsSync(path.join(x.dir,'jobs',job.id)),false);assert.deepEqual(fs.readFileSync(path.join(source.dir,'lesson.json')),source.bytes);
 const y=fixture(t),source2=stored(y,lesson),job2=narration(source2,'math-video');y.adapters.duration=async()=>45.01;
 await assert.rejects(()=>y.runner()(job2,context()),/INVALID_LESSON/);assert.equal(y.calls.offline.length,1);
 const oversized=structuredClone(lesson);oversized.intro=Array.from({length:13},()=>structuredClone(lesson.intro[0]));
 const source3=stored(y,oversized);
 await assert.rejects(()=>y.runner()(narration(source3,'math-video'),context()),/LESSON_TOO_LONG/);
 assert.equal(y.calls.offline.length,1);
});

test('safe source reads reject paths, symlinks, oversized JSON and corrupt source modes',t=>{
 const x=fixture(t),source=stored(x,interactive());
 assert.throws(()=>sourceDirectory(x.config,'../outside'),/ARTIFACT_EXPIRED/);
 assert.throws(()=>readFixedArtifact(source.dir,'../lesson.json'),/ARTIFACT_EXPIRED/);
 const input={narrationOf:source.id,sourceMode:'sample',sourceCapability:'solid-geometry'};
 assert.deepEqual(readSourceLesson(x.config,input,context()).bytes,source.bytes);
 assert.throws(()=>readSourceLesson(x.config,{...input,sourceMode:'export'},context()),/ARTIFACT_EXPIRED/);
 fs.renameSync(path.join(source.dir,'lesson.json'),path.join(source.dir,'checked.json'));
 fs.symlinkSync(path.join(source.dir,'checked.json'),path.join(source.dir,'lesson.json'));
 assert.throws(()=>readSourceLesson(x.config,input,context()),/ARTIFACT_EXPIRED/);
 fs.rmSync(path.join(source.dir,'lesson.json'));fs.writeFileSync(path.join(source.dir,'lesson.json'),source.bytes);
 fs.truncateSync(path.join(source.dir,'lesson.json'),256*1024+1);
 assert.throws(()=>readSourceLesson(x.config,input,context()),/ARTIFACT_EXPIRED/);
});

test('MP4 export reuses only fixed audio/assets and accepts valid legacy video sources',async t=>{
 const x=fixture(t),source=stored(x,interactive());
 for(const [name,bytes]of Object.entries({'preview.html':'<html>fixed</html>','lesson.html':'<html>fixed</html>','audio.wav':wav(),'timeline.json':'{"duration":2,"scenes":[]}','subtitles.srt':'1\n00:00:00,000 --> 00:00:01,000\n固定字幕\n'}))fs.writeFileSync(path.join(source.dir,name),bytes);
 const snapshot=fs.readdirSync(source.dir).map(name=>[name,fs.readFileSync(path.join(source.dir,name))]);
 for(const sourceResult of [{format:'video',audioReady:true},{format:'video'}]){
  const job=task('export',{exportOf:source.id,sourceResult,capability:'math-video'}),result=await x.runner()(job,context());
  assert.equal(result.videoReady,true);assert.equal(result.audioReady,true);
 }
 assert.equal(x.calls.offline.length,0);assert.equal(x.calls.paid.length,0);assert.equal(x.calls.mix,0);
 for(const [name,bytes]of snapshot)assert.deepEqual(fs.readFileSync(path.join(source.dir,name)),bytes);
 assert.ok(x.calls.render.every(r=>r.options.exportVideo===true));
 const out=path.join(x.dir,'rejected');fs.mkdirSync(out);
 assert.throws(()=>copyExportArtifacts(x.config,{exportOf:source.id,sourceResult:{format:'video',audioReady:false}},out,context()),/EXPORT_NOT_AVAILABLE/);
 fs.writeFileSync(path.join(source.dir,'audio.wav'),'not a wave');
 assert.throws(()=>copyExportArtifacts(x.config,{exportOf:source.id,sourceResult:{format:'video',audioReady:true}},out,context()),/ARTIFACT_EXPIRED/);
});

test('trusted narration board preserves full text, typesets raw TeX and conserves subtitles',()=>{
 const source=interactive();source.steps[0].description+='完整推导内容。'.repeat(300);
 const plan=interactiveNarrationPlan(source),clips=plan.sections.map((_,i)=>({file:'speech-'+i+'.wav',duration:3}));
 const tl=compileNarratedBoard(plan,clips),html=makeNarratedBoardPage(plan,tl);
 assert.equal(tl.segments.length,source.steps.length);assert.equal(tl.segments[0].title,source.steps[0].title);assert.ok(tl.segments[0].at>0);
 assert.equal(tl.captions.map(c=>c.text).join(''),plan.sections.map(s=>s.say).join(''));
 assert.ok(tl.captions.every(c=>Array.from(c.text).length<=26&&c.end>c.at));
 assert.match(html,/class="katex"/);assert.match(html,/\\frac\{2\\sqrt\{22\}\}\{11\}/);
 assert.ok(html.includes(source.problem));assert.ok(html.includes(source.steps[0].description));
 for(const id of ['stage','play','seek','tm','audio'])assert.ok(html.includes('id="'+id+'"'));
 assert.match(html,/window\.SV=/);assert.match(html,/window\.renderFrame=seek/);
 const unsafe=interactive();unsafe.title='</h1><script>globalThis.UNTRUSTED=1</script>';
 const escaped=makeNarratedBoardPage(interactiveNarrationPlan(unsafe),tl);
 assert.doesNotMatch(escaped,/<script>globalThis\.UNTRUSTED/);assert.match(escaped,/&lt;script&gt;globalThis\.UNTRUSTED/);
 const longPlan=interactiveNarrationPlan({...source,steps:Array.from({length:8},()=>source.steps[1])});
 assert.throws(()=>compileNarratedBoard(longPlan,longPlan.sections.map((_,i)=>({file:'speech-'+i+'.wav',duration:45}))),/LESSON_TOO_LONG/);
});

test('math speech keeps explanatory prose and refers complete formulas to the display',()=>{
 const speech=safeNarrationText('利用勾股定理可得 $a^2+b^2=c^2$，因此可以求出斜边长度。','计算斜边');
 assert.match(speech,/计算斜边/);assert.match(speech,/利用勾股定理可得/);assert.match(speech,/因此可以求出斜边长度/);assert.match(speech,/公式.*请看屏幕/);assert.doesNotMatch(speech,/\$|\\frac|\^/);
 assert.ok(safeNarrationText('完整条件。'.repeat(200),'说明条件').length<=130);
 assert.equal(safeNarrationText('根据题设建立空间坐标系。'),'根据题设建立空间坐标系。');
});


test('interactive narration board passes the actual self-contained asset gate with embedded audio',async t=>{
 const x=fixture(t),source=stored(x,interactive()),plan=interactiveNarrationPlan(interactive());
 fs.writeFileSync(path.join(source.dir,'audio.wav'),wav());
 const timeline=compileNarratedBoard(plan,plan.sections.map((_,i)=>({file:path.join(source.dir,'speech-'+i+'.wav'),duration:2})));
 const html=await makeStandalonePreview(makeNarratedBoardPage(plan,timeline),{kind:'math-video',jobDir:source.dir});
 assert.match(html,/data:audio\/wav;base64,/);assert.match(html,/Content-Security-Policy/);assert.match(html,/connect-src 'none'/);
 assert.doesNotMatch(html,/src="audio\.wav"|href="file:/);assert.doesNotMatch(html,/speech-\d+\.wav/);
 assert.ok(html.includes(plan.meta.problem));assert.match(html,/class="katex"/);
});


test('each actual silent animation engine plays and seeks on its clock without audio access',async t=>{
 const x=fixture(t);
 for(const capability of ['math-video','physics-video','chem-video']){
  const out=path.join(x.dir,'clock-'+capability);
  await buildAnimatedPreview(validateAnimation(animationSample(capability),capability),[],out,context(),{narration:false});
  const html=fs.readFileSync(path.join(out,'preview.html'),'utf8'),calls=[],frames=[],elements=new Map();let now=0;
  const draw=new Proxy({measureText:value=>({width:Array.from(String(value)).length*20}),createLinearGradient:()=>({addColorStop(){}}),createRadialGradient:()=>({addColorStop(){}})},{get:(target,key)=>key in target?target[key]:(...args)=>calls.push([String(key),...args]),set:(target,key,value)=>(target[key]=value,true)});
  const el=id=>{
   if(!elements.has(id))elements.set(id,{id,width:1920,height:1080,value:0,style:{},classList:{add(){}},getContext:()=>draw,getAttribute:()=>null,blur(){},pause(){}});
   return elements.get(id);
  };
  const audio=el('au');
  audio.play=()=>{throw new Error('SILENT_PREVIEW_CALLED_AUDIO_PLAY');};
  Object.defineProperty(audio,'currentTime',{get(){throw new Error('SILENT_PREVIEW_READ_AUDIO_TIME');},set(){throw new Error('SILENT_PREVIEW_SOUGHT_AUDIO');}});
  const sandbox={window:null,document:{getElementById:el,createElement:()=>el('background'),fonts:{load:()=>Promise.resolve([]),ready:Promise.resolve()},body:el('body')},Image:class{src='';complete=true;},location:{search:''},requestAnimationFrame:fn=>frames.push(fn),addEventListener(){},console,performance:{now:()=>now}};
  sandbox.window=sandbox;const host=vm.createContext(sandbox);
  for(const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g))vm.runInContext(script[1],host,{timeout:2000});
  await host.ready;
  const before=JSON.stringify(calls.slice(-100));
  el('play').onclick();now=3000;
  assert.ok(frames.length,capability+' did not start its animation loop');frames.shift()(now);
  assert.ok(Number(el('seek').value)>0,capability+' silent play did not advance');
  assert.notEqual(JSON.stringify(calls.slice(-100)),before,capability+' silent playback did not redraw its frame');
  const played=JSON.stringify(calls.slice(-100));
  el('seek').value=800;el('seek').oninput();
  assert.ok(Math.abs(Number(el('seek').value)-800)<0.001,capability+' silent seek did not retain its target');
  assert.notEqual(JSON.stringify(calls.slice(-100)),played,capability+' silent seek did not change its draw commands');
  assert.match(el('tm').textContent,/\d+:\d+ \/ \d+:\d+/);
 }
});
