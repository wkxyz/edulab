import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import katex from 'katex';
import {fail} from './validation.mjs';
import {toSrt} from '../../skills/edu-math-video/lesson/scripts/compile.mjs';
import {mixTimelineAudio,publicPreview,renderStoredPreview} from './render.mjs';

const BOARD_PLAYER="(()=>{\n 'use strict';\n const tl=window.TIMELINE,sheets=[...document.querySelectorAll('.sheet')],audio=document.getElementById('audio'),play=document.getElementById('play'),seekbar=document.getElementById('seek'),tm=document.getElementById('tm'),cap=document.getElementById('cap');\n const renderMode=new URLSearchParams(location.search).has('render');\n if(renderMode)document.body.classList.add('render');\n let t=0,playing=false,last=performance.now(),ready=false,errors=[];\n const clamp=v=>Math.max(0,Math.min(tl.duration,Number(v)||0));\n function seek(value){\n  t=clamp(value);let index=0;\n  tl.scenes.forEach((scene,i)=>{if(t>=scene.at)index=i;});\n  sheets.forEach((sheet,i)=>{\n   sheet.hidden=i!==index;\n   if(i===index){const scene=tl.scenes[i],p=Math.max(0,Math.min(1,(t-scene.at)/Math.max(.1,scene.end-scene.at)));sheet.scrollTop=Math.max(0,sheet.scrollHeight-sheet.clientHeight)*p;}\n  });\n  const caption=tl.captions.find(c=>t>=c.at&&t<c.end);cap.textContent=caption?caption.text:'';\n  seekbar.value=String(t/tl.duration*1000);tm.textContent=t.toFixed(1)+' / '+tl.duration.toFixed(1)+'s';\n }\n const loaded=()=>audio.readyState>0;\n function sync(){if(loaded())audio.currentTime=t;if(playing)audio.play().catch(()=>{});else audio.pause();}\n function toggle(){if(t>=tl.duration-.05)t=0;playing=!playing;play.textContent=playing?'暂停':'播放';sync();}\n play.onclick=toggle;document.getElementById('vp').onclick=toggle;\n seekbar.oninput=()=>{seek(Number(seekbar.value)/1000*tl.duration);sync();};\n audio.addEventListener('loadedmetadata',()=>{if(t)audio.currentTime=t;});\n const state={get t(){return t;},get laid(){return ready;},ready:null};\n state.ready=Promise.resolve(document.fonts?.ready).then(()=>{ready=true;if(sheets.length!==tl.scenes.length)errors.push({type:'missing-board-section'});seek(0);});\n window.SV={seek,state:()=>state,report:()=>errors.slice()};window.renderFrame=seek;window.ready=state.ready;\n function loop(now){const dt=Math.max(0,(now-last)/1000);last=now;if(playing){seek(!audio.paused?audio.currentTime:t+dt);if(t>=tl.duration){playing=false;audio.pause();play.textContent='播放';}}requestAnimationFrame(loop);}\n if(!renderMode)requestAnimationFrame(loop);\n})();";
const require=createRequire(import.meta.url);
const escapeHTML=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const json=value=>JSON.stringify(value).replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
function mathText(value){
 const options={throwOnError:false,trust:false,strict:'ignore',maxExpand:200,maxSize:30};
 // Checked interactive answers often contain a complete undelimited TeX
 // expression. Typeset those with the same trusted KaTeX options.
 if(!value.includes('$')&&!/\\[([]/.test(value)&&/\\(?:frac|sqrt|left|right|sin|cos|tan|pi|cdot|times|alpha|beta|theta|in|le|ge)\b/.test(value)){
  try{return katex.renderToString(value,{...options,throwOnError:true});}catch{}
 }
 const pattern=/\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$|\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/g;
 let html='',at=0;
 for(const m of value.matchAll(pattern)){
  html+=escapeHTML(value.slice(at,m.index));
  const tex=m[1]??m[2]??m[3]??m[4];
  html+=katex.renderToString(tex,{displayMode:m[1]!==undefined||m[4]!==undefined,throwOnError:false,trust:false,strict:'ignore',maxExpand:200,maxSize:30});
  at=m.index+m[0].length;
 }
 return html+escapeHTML(value.slice(at));
}
export function compileNarratedBoard(plan,clips){
 if(!Array.isArray(clips)||clips.length!==plan.sections.length||clips.length>12)fail('INVALID_LESSON');
 const audio=[],captions=[],segments=[],scenes=[];let t=0.8;
 for(const [i,section] of plan.sections.entries()){
  const clip=clips[i];
  if(!clip||typeof clip.file!=='string'||!Number.isFinite(clip.duration)||clip.duration<=0||clip.duration>45)fail('INVALID_LESSON');
  const at=t,end=t+clip.duration;if(i>0&&i<plan.sections.length-1)segments.push({title:section.title,at});audio.push({file:clip.file,at});
  const chars=Array.from(section.say);
  for(let j=0;j<chars.length;j+=26){const n=Math.min(26,chars.length-j);captions.push({text:chars.slice(j,j+n).join(''),at:at+clip.duration*j/chars.length,end:at+clip.duration*(j+n)/chars.length,words:[]});}
  scenes.push({title:section.title,at:i===0?0:at,end:end+0.6});t=end+0.6;
 }
 t+=1;if(t>240)fail('LESSON_TOO_LONG');
 return {duration:t,audio,captions,segments,scenes};
}
export function makeNarratedBoardPage(plan,timeline){
 const css=pathToFileURL(require.resolve('katex/dist/katex.min.css')).href;
 const sheets=plan.sections.map((section,i)=>'<section class="sheet"'+(i?' hidden':'')+'><h2 class="ln">'+mathText(section.title)+'</h2><div class="ln detail">'+mathText(section.text)+'</div></section>').join('');
 // Metadata is escaped into DOM text. Only bounded timing and spoken prose go
 // into the fixed player; the checked data field is never interpreted as code.
 const browser={duration:timeline.duration,scenes:timeline.scenes.map(s=>({at:s.at,end:s.end})),captions:timeline.captions};
 return '<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+escapeHTML(plan.meta.title)+'</title><link rel="stylesheet" href="'+css+'"><style>'+
 'html,body{margin:0;background:#132329;color:#173e46;font-family:system-ui,"Noto Sans CJK SC","Microsoft YaHei",sans-serif}#vp{width:min(100vw,calc((100vh - 56px)*16/9));margin:auto;aspect-ratio:16/9}#stage{box-sizing:border-box;width:100%;height:100%;padding:3.2%;display:flex;flex-direction:column;gap:12px;background:#f7f4e8;overflow:hidden}h1{font-size:clamp(18px,2.4vw,34px);margin:0;padding-bottom:8px;border-bottom:3px solid #2d7b86}.sheet{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}.sheet[hidden]{display:none}.ln{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6}.sheet h2{font-size:clamp(17px,2.2vw,30px);color:#146b79;margin:0 0 10px}.detail{font-size:clamp(16px,2.3vw,32px)}.katex{font-size:1.05em}.katex-display{max-width:100%;overflow-x:auto;overflow-y:hidden}#answer{font-size:clamp(13px,1.6vw,22px);border-top:2px solid #c7ccbd;padding-top:8px;max-height:22%;overflow:auto;color:#885520}#cap{height:1.6em;min-height:1.6em;font-size:clamp(13px,1.8vw,24px);color:#4d635d;text-align:center}#controls{display:flex;align-items:center;justify-content:center;gap:12px;height:56px;color:white}#seek{width:55%}button{padding:8px 20px}.render #vp{width:100vw;height:100vh;aspect-ratio:auto}.render #controls{display:none}</style></head><body><div id="vp"><main id="stage"><h1 class="ln">'+mathText(plan.meta.title)+'</h1>'+sheets+'<div id="answer" class="ln">已核对答案：'+mathText(plan.meta.answer)+'</div><div id="cap" class="ln"></div></main></div><div id="controls"><button id="play" type="button">播放</button><input id="seek" aria-label="播放进度" type="range" min="0" max="1000" value="0"><span id="tm"></span></div><audio id="audio" src="audio.wav" preload="metadata"></audio><script>window.TIMELINE='+json(browser)+';</script><script>'+BOARD_PLAYER+'</script></body></html>';
}
export async function buildNarratedBoard(plan,clips,out,ctx,options={}){
 ctx.guard();const timeline=compileNarratedBoard(plan,clips);
 await mixTimelineAudio(timeline,out,ctx);ctx.guard();
 fs.writeFileSync(path.join(out,'timeline.json'),JSON.stringify(timeline));
 fs.writeFileSync(path.join(out,'subtitles.srt'),toSrt(timeline.captions));
 fs.writeFileSync(path.join(out,'preview.html'),makeNarratedBoardPage(plan,timeline));
 await publicPreview(out,'math-video',ctx);
 return {title:plan.meta.title,problem:plan.meta.problem,answer:plan.meta.answer,steps:plan.steps,...await renderStoredPreview(out,ctx,{...options,narration:true,exportVideo:false}),previewEngine:'board'};
}
