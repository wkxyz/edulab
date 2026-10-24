import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fail} from './validation.mjs';

// This is an adapter for checked-in upstream code, not a JavaScript generator.
const HERE=path.dirname(fileURLToPath(import.meta.url));
const UPSTREAM=path.resolve(HERE,'../../skills');
const CAPABILITIES=['math-video','physics-video','chem-video'];
const COLORS=['ink','red','blue','yellow','green','purple','gray','pink','sand','land'];
const MOLECULES=['H2','O2','N2','Cl2','HCl','NO','H2O','CO2','SO2','NO2','SO3','NH3','CH4','HNO3','Cu','Fe','Na'];
const ELEMENTS=new Set('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og'.split(' '));
const bad=()=>fail('INVALID_ANIMATION');
const object=v=>{if(!v||typeof v!=='object'||Array.isArray(v))bad();return v;};
const keys=(v,allowed)=>{object(v);if(Object.keys(v).some(k=>!allowed.includes(k)||['__proto__','constructor','prototype'].includes(k)))bad();};
const number=(v,lo,hi)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<lo||v>hi)bad();return v;};
const integer=(v,lo,hi)=>{number(v,lo,hi);if(!Number.isInteger(v))bad();return v;};
const str=(v,max=160)=>{if(typeof v!=='string'||!v.trim()||v.length>max||v.includes('\0'))bad();return v.trim();};
const optional=(v,max)=>v==null||v===''?'':str(v,max);
const choice=(v,values)=>{if(!values.includes(v))bad();return v;};
const array=(v,min,max)=>{if(!Array.isArray(v)||v.length<min||v.length>max)bad();return v;};
const pair=(v,lo=-10000,hi=10000)=>array(v,2,2).map(n=>number(n,lo,hi));
const id=v=>{str(v,32);if(!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(v)||['constructor','prototype','__proto__'].includes(v))bad();return v;};
const position=(v,capability)=>{const p=pair(v);number(p[0],75,885);number(p[1],capability==='chem-video'?330:140,825);return p;};
const rect=(v,capability)=>{array(v,4,4);position(v.slice(0,2),capability);position(v.slice(2),capability);if(v[2]-v[0]<60||v[3]-v[1]<60)bad();return [...v];};
const round=n=>Math.round(n*1000)/1000;

// Small, bounded chemistry parser. The output is atom/charge data only; it never
// interprets expressions or invokes Python, a shell, or the model's source code.
function formula(input){
 const source=str(input,80);let s=source.replace(/[↑↓]/g,'').replace(/\((?:aq|g|s|l)\)$/,'');let charge=0;
 const q=/\^(?:\{(\d{0,2})([+-])\}|(\d{0,2})([+-]))$/.exec(s);
 if(q){charge=Number(q[1]||q[3]||1)*((q[2]||q[4])==='+'?1:-1);if(!charge||Math.abs(charge)>20)bad();s=s.slice(0,q.index);}
 if(s==='e'){if(charge!==-1)bad();return {source,atoms:{},charge};}
 const atoms=Object.create(null);let work=0;
 const add=(to,from,k=1)=>{for(const [el,n]of Object.entries(from)){to[el]=(to[el]||0)+n*k;if(!Number.isSafeInteger(to[el])||to[el]>100000)bad();}};
 for(const [partIndex,raw]of s.split(/[·*]/).entries()){
  if(!raw)bad();const h=/^(\d{1,3})(.*)$/.exec(raw);if(h&&partIndex===0)bad();const mult=h?integer(Number(h[1]),1,100):1;const part=h?h[2]:raw;let i=0;
  const group=(closing='',depth=0)=>{
   if(depth>5)bad();const out=Object.create(null);
   while(i<part.length){
    if(++work>160)bad();const ch=part[i];if(closing&&ch===closing){i++;return out;}
    let term;if(ch==='('||ch==='['){i++;term=group(ch==='('?')':']',depth+1);if(!Object.keys(term).length)bad();}
    else {const e=/^[A-Z][a-z]?/.exec(part.slice(i));if(!e||!ELEMENTS.has(e[0]))bad();i+=e[0].length;term={[e[0]]:1};}
    const n=/^\d{1,3}/.exec(part.slice(i));const count=n?integer(Number(n[0]),1,100):1;if(n)i+=n[0].length;add(out,term,count);
   }
   if(closing)bad();return out;
  };
  const parsed=group();if(!Object.keys(parsed).length)bad();add(atoms,parsed,mult);
 }
 return {source,atoms:{...atoms},charge};
}
function equationData(o){
 const l=array(o.l,1,5).map(x=>formula(x)),r=array(o.r,1,5).map(x=>formula(x));
 const k=array(o.coefficients,l.length+r.length,l.length+r.length).map(n=>integer(n,1,100));
 const tally=new Map();let ql=0,qr=0;
 [...l,...r].forEach((f,i)=>{const side=i<l.length?'l':'r';for(const [el,n]of Object.entries(f.atoms)){const row=tally.get(el)||{el,l:0,r:0};row[side]+=n*k[i];tally.set(el,row);}if(side==='l')ql+=f.charge*k[i];else qr+=f.charge*k[i];});
 if(ql!==qr||[...tally.values()].some(row=>row.l!==row.r))fail('UNBALANCED_EQUATION');
 return {l:l.map(f=>f.source),r:r.map(f=>f.source),coefficients:k,arrow:choice(o.arrow||'→',['=','→','⇌']),above:optional(o.above,30),below:optional(o.below,30),atoms:[...l,...r].map(f=>f.atoms),tally:[...tally.values()]};
}

const common=['id','kind','at','color','label'];
const geometry=['polyline','polygon','circle','point','angle','graph','text'];
const physics=['ground','incline','block','ball','force','spring','pulley','ray','glass','magneticField','electricField','charge'];
const chemistry=['equation','bridge','tally','ice','particles','beaker','molMap'];
function cleanObject(raw,capability){
 object(raw);const kind=choice(raw.kind,[...geometry,...(capability==='math-video'?['solid']:[]),...(capability==='physics-video'?physics:[]),...(capability==='chem-video'?chemistry:[])]);
 const result={id:id(raw.id),kind,color:choice(raw.color||'blue',COLORS),label:optional(raw.label,48)};
 const check=extra=>keys(raw,[...common,...extra]);
 const at=()=>result.at=position(raw.at,capability);
 switch(kind){
  case 'polyline':case 'polygon':case 'ground':case 'spring':case 'ray':
   check(['points','coils','closed']);result.points=array(raw.points,kind==='polygon'?3:2,kind==='ground'||kind==='spring'?2:64).map(p=>position(p,capability));
   if(kind==='spring')result.coils=integer(raw.coils??10,2,24);break;
  case 'circle':case 'point':case 'ball':case 'charge':case 'pulley':
   check(['radius','sign']);at();result.radius=number(raw.radius??(kind==='point'?7:24),3,150);
   if(kind==='charge')result.sign=choice(raw.sign||'+',['+','-']);break;
  case 'angle':
   check(['a','b','right','radius']);at();result.a=position(raw.a,capability);result.b=position(raw.b,capability);result.right=raw.right===true;result.radius=number(raw.radius??40,12,90);
   if(Math.hypot(...result.a.map((n,i)=>n-result.at[i]))<5||Math.hypot(...result.b.map((n,i)=>n-result.at[i]))<5)bad();break;
  case 'text':check(['text','size']);at();result.text=str(raw.text,100);result.size=number(raw.size??32,18,48);break;
  case 'block':case 'glass':
   check(['width','height','angle']);at();result.width=number(raw.width??100,20,250);result.height=number(raw.height??65,20,200);result.angle=number(raw.angle??0,-Math.PI,Math.PI);break;
  case 'incline':
   check(['angle','run','direction']);at();result.angle=number(raw.angle,0.05,1.2);result.run=number(raw.run,50,650);result.direction=choice(raw.direction??1,[-1,1]);
   position([result.at[0]+result.run*result.direction,result.at[1]-Math.tan(result.angle)*result.run],capability);break;
  case 'force':
   check(['vector','body','scale','magnitude','direction']);at();
   if(raw.magnitude==null){if(raw.direction!=null||raw.scale!=null)bad();result.vector=pair(raw.vector,-400,400);}
   else {result.magnitude=number(raw.magnitude,0.01,10000);result.direction=number(raw.direction,-Math.PI*2,Math.PI*2);result.scale=number(raw.scale??10,0.01,1000);if(result.magnitude*result.scale>400)bad();result.vector=[Math.cos(result.direction)*result.magnitude*result.scale,Math.sin(result.direction)*result.magnitude*result.scale];if(raw.vector!=null&&pair(raw.vector).some((v,i)=>Math.abs(v-result.vector[i])>0.000001))bad();}
   if(raw.body!=null)result.body=id(raw.body);break;
  case 'magneticField':case 'electricField':
   check(['rect','gap','direction']);result.rect=rect(raw.rect,capability);result.gap=number(raw.gap??80,40,180);result.direction=choice(raw.direction||(kind==='magneticField'?'in':'right'),kind==='magneticField'?['in','out']:['up','down','left','right']);break;
  case 'graph':
   check(['width','height','xRange','yRange','points','xLabel','yLabel']);at();result.width=number(raw.width??600,100,720);result.height=number(raw.height??380,80,580);position([result.at[0]+result.width,result.at[1]+result.height],capability);
   result.xRange=pair(raw.xRange,-1000,1000);result.yRange=pair(raw.yRange,-1000,1000);if(result.xRange[1]-result.xRange[0]<0.001||result.yRange[1]-result.yRange[0]<0.001)bad();
   result.points=array(raw.points,2,120).map(p=>pair(p,-1000,1000));result.points.forEach((p,i)=>{if(p[0]<result.xRange[0]||p[0]>result.xRange[1]||p[1]<result.yRange[0]||p[1]>result.yRange[1]||(i&&p[0]<=result.points[i-1][0]))bad();});result.xLabel=optional(raw.xLabel,24)||'x';result.yLabel=optional(raw.yLabel,24)||'y';break;
  case 'solid':
   check(['vertices','edges','scale','yaw','pitch']);at();result.vertices=array(raw.vertices,4,24).map(v=>array(v,3,3).map(n=>number(n,-10,10)));result.edges=array(raw.edges,3,48).map(e=>{array(e,2,3);return [integer(e[0],0,result.vertices.length-1),integer(e[1],0,result.vertices.length-1),e[2]===true];});result.scale=number(raw.scale??90,10,180);result.yaw=number(raw.yaw??0.2,-Math.PI*2,Math.PI*2);result.pitch=number(raw.pitch??0.52,0.1,1.5);break;
  case 'equation':check(['l','r','coefficients','arrow','above','below','atoms','tally']);Object.assign(result,equationData(raw));break;
  case 'bridge':
   check(['equation','fromSpecies','toSpecies','element','fromState','toState','atomCount','electrons']);result.equation=id(raw.equation);result.fromSpecies=integer(raw.fromSpecies,0,9);result.toSpecies=integer(raw.toSpecies,0,9);result.element=choice(raw.element,[...ELEMENTS]);result.fromState=integer(raw.fromState,-8,8);result.toState=integer(raw.toState,-8,8);if(result.fromState===result.toState)bad();result.atomCount=integer(raw.atomCount,1,100);result.electrons=integer(raw.electrons,1,100);if(Math.abs(result.toState-result.fromState)*result.atomCount!==result.electrons)bad();break;
  case 'tally':check(['equation','rows']);at();result.equation=id(raw.equation);break;
  case 'ice':case 'particles':
   check(['equation','initial','extent','unit','rect','radius','final']);result.equation=id(raw.equation);result.initial=array(raw.initial,2,10).map(n=>kind==='particles'?integer(n,0,60):number(n,0,10000));result.extent=kind==='particles'?integer(raw.extent,1,30):number(raw.extent,0.000001,10000);
   if(kind==='ice'){at();result.unit=choice(raw.unit||'mol',['mol','mol/L']);}
   else {result.rect=rect(raw.rect,capability);result.radius=number(raw.radius??12,7,18);}break;
  case 'beaker':
   check(['width','height','level','bubbles']);at();result.width=number(raw.width??220,80,360);result.height=number(raw.height??260,80,400);result.level=number(raw.level??0.55,0,1);result.bubbles=raw.bubbles===true;break;
  case 'molMap':
   check(['values']);at();keys(raw.values||{},['m','n','N','V','c']);result.values=Object.fromEntries(Object.entries(raw.values||{}).map(([k,v])=>[k,str(v,24)]));break;
 }
 return result;
}

function motion(raw){
 object(raw);const kind=choice(raw.kind,['constantAcceleration','circular','harmonic']);
 const out={kind,duration:number(raw.duration,0.01,60),scale:number(raw.scale??1,0.01,300)};
 if(kind==='constantAcceleration'){keys(raw,['kind','duration','scale','velocity','acceleration']);out.velocity=pair(raw.velocity??[0,0],-10000,10000);out.acceleration=pair(raw.acceleration??[0,0],-10000,10000);}
 if(kind==='circular'){keys(raw,['kind','duration','scale','radius','angularVelocity','phase']);out.radius=number(raw.radius,0.001,1000);out.angularVelocity=number(raw.angularVelocity,-50,50);out.phase=number(raw.phase??0,-Math.PI*2,Math.PI*2);if(!out.angularVelocity)bad();}
 if(kind==='harmonic'){keys(raw,['kind','duration','scale','amplitude','angularFrequency','phase']);out.amplitude=pair(raw.amplitude,-1000,1000);out.angularFrequency=number(raw.angularFrequency,0.001,50);out.phase=number(raw.phase??0,-Math.PI*2,Math.PI*2);}
 // Cap the number of complete oscillations, independently of audio duration.
 if((out.angularVelocity||out.angularFrequency||0)*out.duration>Math.PI*16||Math.abs(out.angularVelocity||0)*out.duration>Math.PI*16)bad();
 return out;
}
function displacement(m,t){
 if(m.kind==='constantAcceleration')return m.velocity.map((v,i)=>(v*t+0.5*m.acceleration[i]*t*t)*m.scale);
 if(m.kind==='circular')return [Math.cos(m.phase+m.angularVelocity*t)-Math.cos(m.phase),Math.sin(m.phase+m.angularVelocity*t)-Math.sin(m.phase)].map(n=>n*m.radius*m.scale);
 return m.amplitude.map(a=>a*(Math.sin(m.phase+m.angularFrequency*t)-Math.sin(m.phase))*m.scale);
}

export function validateAnimation(value,capability=value?.capability){
 choice(capability,CAPABILITIES);keys(value,['capability','meta','scenes']);if(value.capability!=null&&value.capability!==capability)bad();
 if(JSON.stringify(value).length>80000)bad();keys(value.meta,['title','problem','answer']);
 const meta={title:str(value.meta.title,80),problem:str(value.meta.problem,1800),answer:str(value.meta.answer,500)};
 let totalLines=0,visuals=0;
 const scenes=array(value.scenes,1,6).map((raw,si)=>{
  keys(raw,['id','title','lines','objects','actions','board']);if(raw.id!=null)id(raw.id);
  const lines=array(raw.lines,1,12).map(l=>{keys(l,['zh','tts','en']);return {zh:str(l.zh,160),tts:str(l.tts||l.zh,160),en:optional(l.en,240)};});totalLines+=lines.length;
  const objects=array(raw.objects,1,24).map(o=>cleanObject(o,capability)),byId=new Map(objects.map(o=>[o.id,o]));if(byId.size!==objects.length)bad();
  const eqs=objects.filter(o=>o.kind==='equation');if(eqs.length>1)bad();
  const ref=(name,kinds)=>{const o=byId.get(name);if(!o||!kinds.includes(o.kind))bad();return o;};
  let loss=0,gain=0;
  for(const o of objects){
   if(o.kind!=='text')visuals++;
   if(o.kind==='force'&&o.body)ref(o.body,['block','ball','charge']);
   if(['bridge','tally','ice','particles'].includes(o.kind)){
    const eq=ref(o.equation,['equation']);
    if(o.kind==='bridge'){
     if(o.fromSpecies>=eq.l.length||o.toSpecies<eq.l.length||o.toSpecies>=eq.atoms.length)bad();
     if((eq.atoms[o.fromSpecies][o.element]||0)*eq.coefficients[o.fromSpecies]<o.atomCount||(eq.atoms[o.toSpecies][o.element]||0)*eq.coefficients[o.toSpecies]<o.atomCount)bad();
     if(o.toState>o.fromState)loss+=o.electrons;else gain+=o.electrons;
    }
    if(o.kind==='tally'){o.rows=eq.tally; if(o.rows.length>6)bad();}
    if(o.kind==='ice'||o.kind==='particles'){
     if(o.initial.length!==eq.coefficients.length)bad();const final=o.initial.map((n,i)=>n+(i<eq.l.length?-1:1)*eq.coefficients[i]*o.extent);if(final.some(n=>n< -1e-9||n>100000))bad();o.final=final.map(n=>round(Math.max(0,n)));
     if(o.kind==='ice')position([o.at[0]+100+Math.min(145,620/eq.coefficients.length)*eq.coefficients.length,o.at[1]+280],capability);
     if(o.kind==='particles'){if([...eq.l,...eq.r].some(s=>!MOLECULES.includes(s))||Math.max(o.initial.reduce((a,b)=>a+b,0),o.final.reduce((a,b)=>a+b,0))>60)bad();}
    }
   }
  }
  if(loss!==gain)fail('UNBALANCED_ELECTRONS');
  const actions=array(raw.actions||[],0,36).map(a=>{
   const kind=choice(a.kind,['reveal','highlight','transform','move','react','flow']);keys(a,['kind','target','line','fraction','endLine','endFraction','translate','rotate','scale','motion']);
   const target=id(a.target),o=byId.get(target);if(!o)bad();const line=integer(a.line,0,lines.length-1),fraction=number(a.fraction??0,0,1),endLine=integer(a.endLine??line,line,lines.length-1),endFraction=number(a.endFraction??1,0,1);if(line===endLine&&endFraction<=fraction)bad();
   const out={kind,target,line,fraction,endLine,endFraction};
   if(kind==='transform'){
    if(!['polyline','polygon','circle','point','solid'].includes(o.kind))bad();out.translate=pair(a.translate??[0,0],-800,800);out.rotate=number(a.rotate??0,-Math.PI*4,Math.PI*4);out.scale=number(a.scale??1,0.1,4);
   }else if(a.translate!=null||a.rotate!=null||a.scale!=null)bad();
   if(kind==='move'){
    if(!['point','circle','block','ball','charge'].includes(o.kind))bad();out.motion=motion(a.motion);
    const times=[0,out.motion.duration];
    // Include exact turning points; checking a few display frames could miss a
    // fast circular/harmonic excursion beyond the diagram region.
    const omega=out.motion.angularVelocity||out.motion.angularFrequency;
    if(omega)for(let k=-20;k<=20;k++)for(const phase of out.motion.kind==='circular'?[0,Math.PI/2]:[Math.PI/2]){const t=(phase+k*Math.PI-out.motion.phase)/omega;if(t>0&&t<out.motion.duration)times.push(t);}
    const samples=times.map(t=>displacement(out.motion,t));
    if(out.motion.kind==='constantAcceleration')for(let axis=0;axis<2;axis++){const t=-out.motion.velocity[axis]/out.motion.acceleration[axis];if(t>0&&t<out.motion.duration)samples.push(displacement(out.motion,t));}
    for(const d of samples)position(o.at.map((v,i)=>v+d[i]),capability);
   }else if(a.motion!=null)bad();
   if(kind==='react'&&!['particles','ice'].includes(o.kind))bad();
   if(kind==='flow'&&!['bridge','ray','beaker'].includes(o.kind))bad();return out;
  });
  for(const o of objects){if(actions.filter(a=>a.target===o.id&&a.kind==='move').length>1||actions.filter(a=>a.target===o.id&&a.kind==='transform').length>1||actions.some(a=>a.target===o.id&&a.kind==='move')&&actions.some(a=>a.target===o.id&&a.kind==='transform'))bad();}
  const board=array(raw.board||[],0,capability==='chem-video'?8:10).map(b=>{keys(b,['text','line','fraction','color']);return {text:str(b.text,100),line:integer(b.line,0,lines.length-1),fraction:number(b.fraction??0,0,1),color:choice(b.color||'ink',COLORS)};});
  return {id:'s'+si,title:str(raw.title,60),lines,objects,actions,board};
 });
 if(totalLines>12)fail('LESSON_TOO_LONG');if(!visuals)bad();return {capability,meta,scenes};
}

// Fractions remain relative to actual speech clips, including when voices change.
export function compileAnimation(value,clips){
 const spec=validateAnimation(value,value.capability),n=spec.scenes.reduce((sum,s)=>sum+s.lines.length,0);array(clips,n,n);
 const audio=[],captions=[],segments=[],scenes=[];let t=0,k=0;
 for(const [si,sc]of spec.scenes.entries()){
  const start=t;segments.push({title:sc.title,at:round(start)});t+=si===0?2.2:1;
  const lines=sc.lines.map(l=>{
   const clip=clips[k++];object(clip);const d=number(clip.duration,0.02,45),file=str(clip.file,2048);if(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(file))bad();
   const line={zh:l.zh,en:l.en,start:round(t),end:round(t+d)};audio.push({file,at:round(t)});
   const chars=Array.from(l.zh),count=Math.ceil(chars.length/30),words=l.en.split(/\s+/).filter(Boolean);
   for(let i=0;i<count;i++)captions.push({at:round(t+d*i/count),end:round(t+d*(i+1)/count),text:chars.slice(i*30,(i+1)*30).join(''),en:words.slice(Math.floor(words.length*i/count),Math.floor(words.length*(i+1)/count)).join(' ')});
   t+=d+0.45;return line;
  });
  t+=0.9-0.45+(si===spec.scenes.length-1?3.2:0);scenes.push({id:sc.id,title:sc.title,start:round(start),end:round(t),lines});
 }
 if(t>240)fail('LESSON_TOO_LONG');return {duration:round(t),fps:30,scenes,audio,captions,segments};
}

const safeJSON=x=>JSON.stringify(x).replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');
const escapeHTML=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
let fontCSS;
export function makeAnimatedPage(value,timeline){
 const spec=validateAnimation(value,value.capability);const folder={'math-video':'edu-math-video','physics-video':'edu-physics-video','chem-video':'edu-chem-video'}[spec.capability];
 const read=name=>fs.readFileSync(path.join(UPSTREAM,folder,'template',name),'utf8');
 const extras=spec.capability==='physics-video'?read('phys.js'):spec.capability==='chem-video'?read('chem.js'):'';
 if(!fontCSS)fontCSS=[['Kuaile','ZCOOLKuaiLe-Regular.ttf'],['PHand','PatrickHand-Regular.ttf']].map(([name,file])=>`@font-face{font-family:'${name}';src:url(data:font/ttf;base64,${fs.readFileSync(path.join(UPSTREAM,'edu-math-video/template/fonts',file)).toString('base64')}) format('truetype');font-display:block}`).join('\n');
 const runtime=fs.readFileSync(path.join(HERE,'animation-runtime.js'),'utf8');
 // The browser only needs the mixed audio. Keep server-local clip paths out of
 // the delivered HTML; the separate timeline.json still supplies the mixer.
 const browserTimeline={...timeline,audio:[]};
 return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(spec.meta.title)}</title><style>${fontCSS}\nhtml,body{margin:0;background:#152431;color:#eee;font-family:system-ui,sans-serif}canvas{display:block;width:min(100vw,calc((100vh - 52px)*16/9));height:auto;margin:auto;cursor:pointer}#bar{display:flex;align-items:center;justify-content:center;gap:12px;height:52px}#seek{width:55%}body.render #bar{display:none}body.render canvas{width:100vw;height:100vh}</style></head><body><canvas id="c" width="1920" height="1080"></canvas><div id="bar"><button id="play" type="button">播放</button><input aria-label="播放进度" id="seek" type="range" min="0" max="1000" value="0"><span id="tm"></span></div><audio id="au" src="audio.wav" preload="metadata"></audio><script>window.TIMELINE=${safeJSON(browserTimeline)};window.ANIMATION_SPEC=${safeJSON(spec)};</script><script>${read('engine.js')}</script><script>${extras}</script><script>${runtime}</script><script>boot();</script></body></html>`;
}

function srt(timeline){const stamp=s=>{const ms=Math.round(s*1000);return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;};return timeline.captions.map((c,i)=>`${i+1}\n${stamp(c.at)} --> ${stamp(c.end)}\n${c.text}${c.en?'\n'+c.en:''}\n`).join('\n');}
export async function buildAnimatedPreview(value,clips,outDir,ctx){
 ctx.guard();const spec=validateAnimation(value,value.capability),timeline=compileAnimation(spec,clips);fs.mkdirSync(outDir,{recursive:true});
 fs.writeFileSync(path.join(outDir,'preview.html'),makeAnimatedPage(spec,timeline));fs.writeFileSync(path.join(outDir,'timeline.json'),JSON.stringify(timeline));fs.writeFileSync(path.join(outDir,'subtitles.srt'),srt(timeline));ctx.guard();
 return {format:'video',title:spec.meta.title,problem:spec.meta.problem,answer:spec.meta.answer,steps:spec.scenes.map(s=>({title:s.title,description:s.lines.map(l=>l.zh).join('')})),duration:timeline.duration,segments:timeline.segments};
}

export function animationInstructions(capability){
 choice(capability,CAPABILITIES);
 const commonText=`输出严格 JSON：{meta:{title,problem,answer},scenes:[{title,lines:[{zh,tts,en?}],objects:[{id,kind,...}],actions:[{kind,target,line,fraction?,endLine?,endFraction?,...}],board:[{text,line,fraction?,color?}]}]}. scenes一到六幕，全部lines合计最多十二句。zh/tts各最多160字，tts为可直接读的中文；en可选。所有引用使用objects的id，id限英文字母开头、字母数字下划线。颜色只能ink/red/blue/yellow/green/purple/gray/pink/sand/land。没有JS、函数、HTML、URL、文件路径、任意表达式或额外字段。坐标1920×1080：图形限左区x75..885、y${capability==='chem-video'?330:140}..825；右侧board自动排版，每行短句。at:[x,y]，points:[[x,y],...]。最多24对象、36动作/幕。所有动画以零基line+fraction(0..1)起，到endLine+endFraction止，默认同句末尾。action.kind=reveal或highlight只需target,line；transform仅几何对象，附translate:[dx,dy],rotate(弧度),scale；move附motion；react仅particles/ice；flow仅bridge/ray/beaker。默认对象直接可见，reveal使其从指定句开始绘制。每题至少一个实际图形，不能只输出文字。通用对象：polyline/polygon{points}、circle/point{at,radius}、angle{at,a:[x,y],b:[x,y],right?,radius?}、text{at,text,size?}、graph{at(左上),width,height,xRange:[min,max],yRange:[min,max],points(按x严格递增且在范围内),xLabel?,yLabel?}。board为最多${capability==='chem-video'?8:10}行{text,line,color?}，不要写LaTeX命令，物理/化学可用_和^上下标。`;
 if(capability==='math-video')return commonText+`数学手绘必须用图形展示推理，例如polygon+angle、移动点或transform平移/旋转重合；solid{at,vertices:[[x,y,z]],edges:[[顶点索引,顶点索引,是否隐藏]],scale?,yaw?,pitch?}支持立体投影。示例对象{id:"tri",kind:"polygon",points:[[180,650],[180,280],[670,650]],color:"blue"}；动作{kind:"transform",target:"tri",line:1,translate:[50,0],rotate:0.2,scale:0.8}。`;
 if(capability==='physics-video')return commonText+`物理对象：ground{points:[a,b]}、incline{at(底端),angle:弧度,run:水平长,direction:1或-1}、block{at(底边中点),width,height,angle?}、ball/pulley/charge{at,radius,sign?(+/-)}、force{at,body?:对象id,vector:[dx,dy]}或force{at,body?,magnitude,direction:弧度,scale:像素每牛}，同幕力使用同一scale；spring{points:[a,b],coils:2..24}、ray{points}、glass{at,width,height,angle?}、magneticField{rect:[x0,y0,x1,y1],gap:40..180,direction:in/out}、electricField{rect,gap,direction:up/down/left/right}。move只作用point/circle/block/ball/charge。motion种类：{kind:"constantAcceleration",duration:真实物理秒,scale:像素每米,velocity:[vx,vy],acceleration:[ax,ay]}，或{kind:"circular",duration,scale,radius,angularVelocity,phase?}，或{kind:"harmonic",duration,scale,amplitude:[ax,ay],angularFrequency,phase?}。屏幕y向下，物理时间线性前进，位置从at加解析位移，圆周/简谐位移相对初相位；每段motion最多8周，速度/加速度与答案一致。例a=3m/s²,t=2s,s=6m：ball at[180,600]，motion duration2,scale80,velocity[0,0],acceleration[3,0]，终点[660,600]。`;
 return commonText+`化学以配平后的方程式为中心。equation{id,kind:"equation",l:[反应物化学式],r:[产物式],coefficients:[按l再r的正整数系数],arrow:"→"或"="或"⇌",above?,below?}，每幕最多一个，自动放顶部。化学式用普通数字括号，下标自动排；离子电荷写Fe^{3+}/SO4^{2-}/e^-；必须原子及电荷守恒。tally{at,equation:方程式id}自动计算原子守恒。bridge{equation,fromSpecies:反应物全局索引,toSpecies:产物全局索引,element:"Cu",fromState:0,toState:2,atomCount:3,electrons:6}；同幕失/得电子总数必须相等，电子数=变价数×原子数。ice{at,equation,initial:[全部物种初始量],extent:非负反应进度,unit:"mol"或"mol/L"}自动按系数生成三段式，转化后不能为负。particles{equation,rect:[x0,y0,x1,y1],initial:[全部物种整数粒子数],extent:正整数反应进度,radius:7..18}按系数成组反应，初末总粒子≤60，分子限${MOLECULES.join('/')}；动作react控制反应。beaker{at(底部中心),width,height,level:0..1,bubbles:true}；molMap{at,values:{m?,n?,N?,V?,c?}}。甲烷燃烧例equation l["CH4","O2"],r["CO2","H2O"],coefficients[1,2,1,2]；particles initial[3,6,0,0],extent3；必须再用react动作。`;
}
