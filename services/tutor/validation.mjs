export class TutorError extends Error {
  constructor(code,status=400){super(code);this.code=code;this.status=status;}
}
export const fail=(code,status)=>{throw new TutorError(code,status);};
export function validateInput(input){
 if(!input||typeof input!=='object'||Array.isArray(input))fail('INVALID_INPUT');
 const capability=input.capability??DEFAULT_CAPABILITY;
 const entry=CAPABILITIES.find(x=>x.id===capability);if(!entry)fail('INVALID_CAPABILITY');
 const style=input.style||'whiteboard';
 if(!['chalk','lab','whiteboard','notebook','handdrawn'].includes(style)||style==='handdrawn'&&capability!=='math-video')fail('INVALID_STYLE');
 if(input.exportVideo!==undefined&&typeof input.exportVideo!=='boolean')fail('INVALID_INPUT');
 const delivery=input.delivery??'lesson';
 if(!['lesson','video'].includes(delivery))fail('INVALID_DELIVERY');
 if(entry.kind==='interactive'&&delivery==='video')fail('INVALID_DELIVERY');
 const settings={capability,style,delivery,...(entry.kind==='video'?{exportVideo:delivery==='video'&&input.exportVideo===true}:{})};
 if(input.sampleId){
  if(!['equation','default','random'].includes(input.sampleId)||input.sampleId==='equation'&&capability!=='math-video'||input.sampleId==='random'&&entry.kind!=='interactive')fail('INVALID_SAMPLE');
  return {sampleId:input.sampleId,...settings};
 }
 const text=typeof input.text==='string'?input.text.trim():'';
 if(text.length>1600)fail('TEXT_TOO_LONG');
 let image;
 if(input.image){
  if(typeof input.image!=='string'||input.image.length>5600000)fail('IMAGE_TOO_LARGE');
  const m=/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(input.image);
  if(!m)fail('INVALID_IMAGE');
  const b=Buffer.from(m[2],'base64');if(b.length>4*1024*1024)fail('IMAGE_TOO_LARGE');
  const valid=m[1]==='png'?b.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):m[1]==='jpeg'?b[0]===255&&b[1]===216&&b[2]===255:b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP';
  if(!valid)fail('INVALID_IMAGE');image=input.image;
 }
 if(!text&&!image)fail('EMPTY_QUESTION');
 return {text,image,...settings};
}
const boundedText=(s,n=500)=>{if(typeof s!=='string'||!s.trim()||s.length>n||s.includes('\0'))fail('INVALID_LESSON');return s.trim();};
export function validateLesson(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||JSON.stringify(value).length>48000)fail('INVALID_LESSON');
 const meta={title:boundedText(value.meta?.title,80),problem:boundedText(value.meta?.problem,1800),answer:boundedText(value.meta?.answer,500),style:['chalk','lab','whiteboard','notebook'].includes(value.meta?.style)?value.meta.style:'whiteboard'};
 if(!Array.isArray(value.intro)||!value.intro.length||!Array.isArray(value.scenes)||!value.scenes.length||value.scenes.length>6)fail('INVALID_LESSON');
 let figure,figureContext;
 try{figure=validateFigure(value.figure);figureContext=createFigureActionContext(figure,value.scenes.flatMap(s=>(s.beats||[]).flatMap(b=>b.do||[])));}catch(e){fail(e.code||'UNSUPPORTED_ANIMATION');}
 const intro=value.intro.map(x=>({show:boundedText(x.show),say:boundedText(x.say,160),speak:boundedText(x.speak||x.say,160)}));
 const scenes=value.scenes.map(x=>{
  if(!Array.isArray(x.beats)||!x.beats.length)fail('INVALID_LESSON');
  return {title:boundedText(x.title,60),goal:boundedText(x.goal||x.title,160),beats:x.beats.map(b=>{
   const out={say:boundedText(b.say,160),speak:boundedText(b.speak||b.say,160),do:[]};
   if(b.do&&!Array.isArray(b.do))fail('INVALID_LESSON');
   for(const a of b.do||[]){
    if(out.do.length>=8)fail('INVALID_LESSON');
    let visual;try{visual=validateFigureAction(a,figure,figureContext);}catch(e){fail(e.code||'UNSUPPORTED_ANIMATION');}
    if(visual)out.do.push(visual);
    else if(typeof a.write==='string')out.do.push({write:boundedText(a.write,160)});
    else if(a.emph==='last')out.do.push({emph:'last'});
    else if(typeof a.tip==='string')out.do.push({tip:boundedText(a.tip,80),hold:4});
    else fail('UNSUPPORTED_ANIMATION');
   }return out;
  })};
 });
 if(intro.length+scenes.reduce((n,s)=>n+s.beats.length,0)>12)fail('LESSON_TOO_LONG');
 // Figures and animation operations are bounded data interpreted by the trusted edulab engine.
 return {meta,intro,scenes,...(figure?{figure}:{})};
}
import {CAPABILITIES,DEFAULT_CAPABILITY} from '../../apps/web/capabilities.mjs';
import {validateFigure,validateFigureAction,createFigureActionContext} from './lesson-figures.mjs';
