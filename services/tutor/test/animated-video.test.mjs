import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {animationInstructions,validateAnimation,compileAnimation,makeAnimatedPage,buildAnimatedPreview} from '../animated-video.mjs';

const line={zh:'观察物体的位置变化。',tts:'观察物体的位置变化。',en:'Watch the object move.'};
const fixture=(capability='physics-video')=>({capability,meta:{title:'匀加速运动',problem:'物体从静止开始，加速度为三米每二次方秒，求两秒的位移。',answer:'六米'},scenes:[{title:'真实运动',lines:[{...line}],objects:[{id:'ball',kind:capability==='physics-video'?'ball':'point',at:[180,600],radius:16}],actions:[{kind:'move',target:'ball',line:0,motion:{kind:'constantAcceleration',duration:2,scale:80,velocity:[0,0],acceleration:[3,0]}}],board:[{text:'s = ½at^2 = 6 m',line:0}]}]});
const chem=()=>({capability:'chem-video',meta:{title:'甲烷燃烧',problem:'甲烷完全燃烧的化学方程式是什么？',answer:'CH4 + 2O2 → CO2 + 2H2O'},scenes:[{title:'原子守恒',lines:[{...line}],objects:[{id:'eq',kind:'equation',l:['CH4','O2'],r:['CO2','H2O'],coefficients:[1,2,1,2]},{id:'gas',kind:'particles',equation:'eq',rect:[100,400,850,790],initial:[3,6,0,0],extent:3}],actions:[{kind:'react',target:'gas',line:0}]}]});
const clips=spec=>spec.scenes.flatMap(s=>s.lines.map(()=>({file:'speech.wav',duration:4})));

// Run the actual bundled engine and dispatcher in a deterministic canvas host.
// This catches global-name/boot/render integration errors without opening a browser.
async function canvasHost(spec){
 const timeline=compileAnimation(spec,clips(spec)),html=makeAnimatedPage(spec,timeline),calls=[];
 const context=new Proxy({measureText:s=>({width:Array.from(String(s)).length*20}),createLinearGradient:()=>({addColorStop(){}}),createRadialGradient:()=>({addColorStop(){}})}, {get:(target,key)=>key in target?target[key]:(...args)=>{calls.push([String(key),...args]);},set:(target,key,value)=>(target[key]=value,true)});
 const elements=new Map();const el=id=>{if(!elements.has(id))elements.set(id,{id,width:1920,height:1080,value:0,currentTime:0,style:{},classList:{add(){}},getContext:()=>context,getAttribute:()=>id==='au'?'audio.wav':null,play:()=>Promise.resolve(),pause(){},blur(){}});return elements.get(id);};
 const sandbox={window:null,document:{getElementById:el,createElement:()=>el('background'),fonts:{load:()=>Promise.resolve([]),ready:Promise.resolve()},body:el('body')},Image:class{src='';complete=true;},location:{search:'?render=1'},requestAnimationFrame(){},addEventListener(){},console,performance:{now:()=>0}};sandbox.window=sandbox;
 const host=vm.createContext(sandbox);
 for(const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g))vm.runInContext(script[1],host,{timeout:2000});
 await host.ready;
 return {host,timeline,html,calls,run:code=>vm.runInContext(code,host,{timeout:2000})};
}

test('bounded animation instructions and normalization cover all three actual engines',()=>{
 for(const capability of ['math-video','physics-video','chem-video'])assert.match(animationInstructions(capability),/严格 JSON/);
 for(const input of [fixture(),fixture('math-video'),chem()]){
  const clean=validateAnimation(input,input.capability);
  assert.deepEqual(validateAnimation(JSON.parse(JSON.stringify(clean)),input.capability),clean);
 }
});

test('timeline uses real clip durations and stable speech-relative cues',()=>{
 const input=fixture();input.scenes[0].lines=[{...line},{...line}];input.scenes.push({...structuredClone(input.scenes[0]),lines:[{...line}]});
 const tl=compileAnimation(input,[{file:'/tmp/first.wav',duration:2},{file:'/tmp/second.wav',duration:3},{file:'/tmp/third.wav',duration:4}]);
 assert.equal(tl.audio[0].at,2.2);assert.equal(tl.audio[1].at,4.65);assert.equal(tl.scenes[0].end,8.55);assert.equal(tl.audio[2].at,9.55);assert.equal(tl.duration,17.65);assert.equal(tl.scenes[1].lines[0].end,13.55);
 assert.throws(()=>compileAnimation(input,[]),/INVALID_ANIMATION/);
 assert.throws(()=>compileAnimation(fixture(),[{file:'x.wav',duration:Infinity}]),/INVALID_ANIMATION/);
 assert.throws(()=>compileAnimation(fixture(),[{file:'https://example.com/voice',duration:3}]),/INVALID_ANIMATION/);
});

test('rejects executable fields, invalid references and unbounded loops or trajectories',()=>{
 const mutations=[x=>x.scenes[0].objects[0].javascript='process.exit()',x=>x.scenes[0].objects[0].kind='iframe',x=>x.scenes[0].objects[0].src='https://example.com',x=>x.scenes[0].actions[0].target='missing',x=>x.scenes[0].actions[0].motion.acceleration=[1000000,0],x=>x.scenes[0].actions[0].line=10,x=>x.scenes[0].actions[0].endFraction=0,x=>x.scenes[0].objects[0].id='constructor',x=>x.scenes[0].objects[0].radius=-2,x=>x.scenes[0].objects[0].at=[NaN,600],x=>x.scenes[0].actions[0].motion={kind:'harmonic',duration:60,angularFrequency:50,amplitude:[1,0]}];
 for(const mutate of mutations){const x=fixture();mutate(x);assert.throws(()=>validateAnimation(x,x.capability),/INVALID_ANIMATION/);}
 const field=fixture();field.scenes[0].objects.push({id:'field',kind:'magneticField',rect:[100,200,800,700],gap:0});assert.throws(()=>validateAnimation(field,field.capability));
 const spring=fixture();spring.scenes[0].objects.push({id:'spring',kind:'spring',points:[[100,300],[300,300]],coils:10000});assert.throws(()=>validateAnimation(spring,spring.capability));
 const tooLong=fixture();tooLong.scenes[0].lines=Array.from({length:12},()=>({...line}));tooLong.scenes.push({...structuredClone(tooLong.scenes[0]),lines:[{...line}]});assert.throws(()=>validateAnimation(tooLong,tooLong.capability),/LESSON_TOO_LONG/);
});

test('chemistry validates atoms, charge, nonnegative amounts and electron conservation',()=>{
 const input=chem(),clean=validateAnimation(input,input.capability);
 assert.deepEqual(clean.scenes[0].objects[0].tally,[{el:'C',l:1,r:1},{el:'H',l:4,r:4},{el:'O',l:4,r:4}]);assert.deepEqual(clean.scenes[0].objects[1].final,[0,0,3,6]);
 const unbalanced=chem();unbalanced.scenes[0].objects[0].coefficients=[1,1,1,2];assert.throws(()=>validateAnimation(unbalanced,unbalanced.capability),/UNBALANCED_EQUATION/);
 const shortage=chem();shortage.scenes[0].objects[1].initial=[1,1,0,0];assert.throws(()=>validateAnimation(shortage,shortage.capability),/INVALID_ANIMATION/);
 const ion=chem();ion.scenes[0].objects=[{id:'eq',kind:'equation',l:['Fe^{2+}'],r:['Fe^{3+}'],coefficients:[1,1]}];ion.scenes[0].actions=[];assert.throws(()=>validateAnimation(ion,ion.capability),/UNBALANCED_EQUATION/);
 ion.scenes[0].objects[0].r.push('e^-');ion.scenes[0].objects[0].coefficients.push(1);assert.doesNotThrow(()=>validateAnimation(ion,ion.capability));
 const malformed=chem();malformed.scenes[0].objects[0].l=['C(H4','O2'];assert.throws(()=>validateAnimation(malformed,malformed.capability));
 const bridge=chem();bridge.scenes[0].objects=[{id:'eq',kind:'equation',l:['Cu','HNO3'],r:['Cu(NO3)2','NO','H2O'],coefficients:[3,8,3,2,4]}, {id:'loss',kind:'bridge',equation:'eq',fromSpecies:0,toSpecies:2,element:'Cu',fromState:0,toState:2,atomCount:3,electrons:6}];bridge.scenes[0].actions=[];assert.throws(()=>validateAnimation(bridge,bridge.capability),/UNBALANCED_ELECTRONS/);
 bridge.scenes[0].objects.push({id:'gain',kind:'bridge',equation:'eq',fromSpecies:1,toSpecies:3,element:'N',fromState:5,toState:2,atomCount:2,electrons:6});assert.doesNotThrow(()=>validateAnimation(bridge,bridge.capability));
});

test('trusted runtime follows analytic motion linearly at the real speech midpoint',async()=>{
 const {host,timeline,run,calls}=await canvasHost(fixture());
 const start=timeline.scenes[0].lines[0].start,end=timeline.scenes[0].lines[0].end;
 assert.equal(host.animationStateAt(start).objects.ball.at[0],180);
 assert.equal(host.animationStateAt((start+end)/2).objects.ball.at[0],300); // s = ½×3×1², scale80
 assert.equal(host.animationStateAt(end).objects.ball.at[0],660);
 run(`window.physicsBallCount=0; const originalBallForTest=ball; ball=(...args)=>{window.physicsBallCount++;return originalBallForTest(...args)}; window.renderFrame(${(start+end)/2})`);assert.equal(host.physicsBallCount,1);assert.ok(calls.some(c=>c[0]==='stroke'));assert.equal(host.ANIMATION_REPORT.engine,'physics-video');
});

test('actual handdrawn engine renders geometric transforms and numerical graph samples',async()=>{
 const input=fixture('math-video');input.scenes[0].objects=[{id:'tri',kind:'polygon',points:[[180,600],[180,300],[600,600]]},{id:'g',kind:'graph',at:[110,650],width:600,height:120,xRange:[0,4],yRange:[0,16],points:[[0,0],[1,1],[2,4],[3,9],[4,16]]}];input.scenes[0].actions=[{kind:'transform',target:'tri',line:0,translate:[40,0],rotate:0.1,scale:0.8}];
 const {host,run,calls}=await canvasHost(input);run('window.renderFrame(4.2)');assert.ok(calls.some(c=>c[0]==='stroke'));assert.equal(host.animationStateAt(6.2).objects.tri.scale,0.8);assert.equal(host.ANIMATION_REPORT.engine,'math-video');
});

test('actual chemistry engine derives stoichiometric particles and renders its equation',async()=>{
 const input=chem();const {host,run,calls}=await canvasHost(input);run('window.renderFrame(4.2)');assert.equal(host.ANIMATION_REPORT.engine,'chem-video');assert.equal(host.animationStateAt(4.2).objects.gas.reaction,0.5);assert.ok(calls.some(c=>c[0]==='fillText'&&/^CH/.test(c[1])));
});

test('vendored physics and chemistry prop APIs are compatible with bounded dispatch',async()=>{
 const input=fixture();input.scenes[0].objects=[
  {id:'surface',kind:'ground',points:[[110,740],[820,740]]},
  {id:'incline',kind:'incline',at:[120,700],angle:0.3,run:400},
  {id:'body',kind:'block',at:[450,600],width:80,height:60},
  {id:'weight',kind:'force',at:[450,570],body:'body',magnitude:3,direction:Math.PI/2,scale:20,label:'mg'},
  {id:'coil',kind:'spring',points:[[200,400],[400,400]],coils:8},
  {id:'wheel',kind:'pulley',at:[600,400],radius:35},
  {id:'light',kind:'ray',points:[[120,200],[650,300]]},
  {id:'slab',kind:'glass',at:[700,600],width:80,height:120,angle:0.2},
  {id:'magnetic',kind:'magneticField',rect:[120,200,800,700],gap:100},
  {id:'electric',kind:'electricField',rect:[120,200,800,700],gap:100,direction:'down'},
  {id:'positive',kind:'charge',at:[470,450],radius:20,sign:'+'},
  {id:'orbit',kind:'ball',at:[650,500],radius:10},
  {id:'oscillator',kind:'ball',at:[450,600],radius:10}
 ];input.scenes[0].actions=[{kind:'move',target:'orbit',line:0,motion:{kind:'circular',duration:2,scale:60,radius:1,angularVelocity:Math.PI}},{kind:'move',target:'oscillator',line:0,motion:{kind:'harmonic',duration:2,scale:60,amplitude:[1,0],angularFrequency:Math.PI}},{kind:'flow',target:'light',line:0}];
 const {run}=await canvasHost(input);assert.doesNotThrow(()=>run('window.renderFrame(4.2)'));
 const c=chem();c.scenes[0].objects.push({id:'table',kind:'ice',equation:'eq',at:[100,340],initial:[1,2,0,0],extent:1},{id:'count',kind:'tally',at:[470,350],equation:'eq'},{id:'cup',kind:'beaker',at:[700,780],width:140,height:220,bubbles:true},{id:'amount',kind:'molMap',at:[450,580],values:{n:'一摩尔',m:'十六克'}});c.scenes[0].actions.push({kind:'react',target:'table',line:0});
 const result=await canvasHost(c);assert.doesNotThrow(()=>result.run('window.renderFrame(4.2)'));
});

test('self-contained page safely embeds hostile text and includes only fixed code',()=>{
 const input=fixture();input.meta.title='</script><img src=x onerror=alert(1)>';input.scenes[0].lines[0].zh='</script><script>globalThis.owned=true</script>';
 const sourceClips=[{file:'/private/server/speech.wav',duration:4}],tl=compileAnimation(input,sourceClips),html=makeAnimatedPage(input,tl);
 assert.ok(!html.includes('<script>globalThis.owned'));assert.match(html,/\\u003c\/script>/);assert.match(html,/data:font\/ttf;base64,/);assert.match(html,/<audio id="au" src="audio.wav"/);assert.ok(!/src="https?:/.test(html));assert.ok(!/new Function\(|\beval\(/.test(html));assert.ok(!html.includes('/private/server/speech.wav'));assert.equal(tl.audio[0].file,'/private/server/speech.wav');
});

test('preview builder writes playable HTML, exact timeline and bilingual subtitles',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'edulab-animated-test-'));let guards=0;
 try{const spec=chem(),metadata=await buildAnimatedPreview(spec,clips(spec),dir,{guard(){guards++;}});assert.equal(metadata.format,'video');assert.equal(metadata.title,'甲烷燃烧');assert.equal(metadata.duration,10.3);assert.equal(guards,2);assert.match(fs.readFileSync(path.join(dir,'subtitles.srt'),'utf8'),/Watch the object move/);assert.ok(fs.statSync(path.join(dir,'preview.html')).size>1000000);assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'timeline.json'))).audio[0].at,2.2);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
