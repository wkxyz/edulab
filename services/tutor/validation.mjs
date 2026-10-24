export class TutorError extends Error {
  constructor(code,status=400){super(code);this.code=code;this.status=status;}
}
export const fail=(code,status)=>{throw new TutorError(code,status);};
export function validateInput(input){
 if(!input||typeof input!=='object'||Array.isArray(input))fail('INVALID_INPUT');
 const style=input.style||'whiteboard';
 if(!['chalk','lab','whiteboard','notebook'].includes(style))fail('INVALID_STYLE');
 if(input.sampleId){if(input.sampleId!=='equation')fail('INVALID_SAMPLE');return {sampleId:input.sampleId,style};}
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
 return {text,image,style};
}
const boundedText=(s,n=500)=>{if(typeof s!=='string'||!s.trim()||s.length>n||s.includes('\0'))fail('INVALID_LESSON');return s.trim();};
export function validateLesson(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||JSON.stringify(value).length>48000)fail('INVALID_LESSON');
 const meta={title:boundedText(value.meta?.title,80),problem:boundedText(value.meta?.problem,1800),answer:boundedText(value.meta?.answer,500),style:['chalk','lab','whiteboard','notebook'].includes(value.meta?.style)?value.meta.style:'whiteboard'};
 if(!Array.isArray(value.intro)||!value.intro.length||!Array.isArray(value.scenes)||!value.scenes.length||value.scenes.length>6)fail('INVALID_LESSON');
 const intro=value.intro.map(x=>({show:boundedText(x.show),say:boundedText(x.say,160),speak:boundedText(x.speak||x.say,160)}));
 const scenes=value.scenes.map(x=>{
  if(!Array.isArray(x.beats)||!x.beats.length)fail('INVALID_LESSON');
  return {title:boundedText(x.title,60),goal:boundedText(x.goal||x.title,160),beats:x.beats.map(b=>{
   const out={say:boundedText(b.say,160),speak:boundedText(b.speak||b.say,160),do:[]};
   if(b.do&&!Array.isArray(b.do))fail('INVALID_LESSON');
   for(const a of b.do||[]){
    if(out.do.length>=8)fail('INVALID_LESSON');
    if(typeof a.write==='string')out.do.push({write:boundedText(a.write,160)});
    else if(a.emph==='last')out.do.push({emph:'last'});
    else if(typeof a.tip==='string')out.do.push({tip:boundedText(a.tip,80),hold:4});
    else fail('UNSUPPORTED_ANIMATION');
   }return out;
  })};
 });
 if(intro.length+scenes.reduce((n,s)=>n+s.beats.length,0)>12)fail('LESSON_TOO_LONG');
 // The initial public adapter accepts declarative board actions only. Never execute model-supplied JS,
 // function expressions or HTML. Advanced diagrams can be added with a separately validated schema.
 if(value.figure)fail('UNSUPPORTED_ANIMATION');
 return {meta,intro,scenes};
}
