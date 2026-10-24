// Only KaTeX's trusted runtime produces markup. Every character outside a math
// span, including any HTML received in lesson metadata, stays escaped text.
const escapeText=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const delimiters=[
  {open:'$$',close:'$$',display:true},
  {open:'\\[',close:'\\]',display:true},
  {open:'\\(',close:'\\)',display:false},
  {open:'$',close:'$',display:false},
];
function escapedAt(text,index){
  let slashes=0;for(let i=index-1;i>=0&&text[i]==='\\';i--)slashes++;
  return slashes%2===1;
}
function closingAt(text,start,delimiter){
  for(let i=start;i<text.length;i++){
    if(!text.startsWith(delimiter.close,i)||escapedAt(text,i))continue;
    if(delimiter.close==='$'&&(text[i+1]==='$'||text[i-1]==='$'))continue;
    return i;
  }
  return -1;
}
function formula(text,{display,raw,renderer}){
  if(typeof renderer?.renderToString!=='function')return escapeText(raw);
  try{
    const html=renderer.renderToString(text,{
      displayMode:display,trust:false,throwOnError:false,strict:'ignore',
      output:'htmlAndMathml',maxExpand:1000,maxSize:10,macros:{},
    });
    return `<span class="math-formula ${display?'math-block':'math-inline'}">${html}</span>`;
  }catch{return escapeText(raw);}
}

/** Format plain lesson text and standard math delimiters as safe HTML.
 * `answer` also accepts an entire undelimited TeX expression, as returned by
 * the exact solvers. The renderer option lets tests use the same pinned KaTeX.
 */
export function formatMath(value,{answer=false,renderer=globalThis.katex}={}){
  const text=String(value??'');let html='',plainStart=0,found=false;
  for(let i=0;i<text.length;i++){
    if(escapedAt(text,i))continue;
    const delimiter=delimiters.find(item=>text.startsWith(item.open,i));
    if(!delimiter)continue;
    const start=i+delimiter.open.length,end=closingAt(text,start,delimiter);
    if(end<start||!text.slice(start,end).trim())continue;
    const stop=end+delimiter.close.length,raw=text.slice(i,stop);
    html+=escapeText(text.slice(plainStart,i))+formula(text.slice(start,end),{display:delimiter.display,raw,renderer});
    found=true;plainStart=stop;i=stop-1;
  }
  if(!found&&answer&&/\\[A-Za-z]+/.test(text)&&!/(?:\$|\\[([])/.test(text)){
    return formula(text.trim(),{display:false,raw:text,renderer});
  }
  return html+escapeText(text.slice(plainStart));
}
