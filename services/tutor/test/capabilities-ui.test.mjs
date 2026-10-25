import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {CAPABILITIES, DEFAULT_CAPABILITY, getCapability} from '../../../apps/web/capabilities.mjs';
import * as ui from '../../../apps/web/ui.mjs';
import {formatMath} from '../../../apps/web/math-format.mjs';

const source=(await fs.readFile(new URL('../../../apps/web/app.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');

// A DOM boundary harness exercises requests and rendered states without launching
// a browser or contacting providers. Layout and media playback need browser QA.
function harness({live=true,healthData={}}={}){
  let nodes=[];const requests=[],derivedRequests=[],taskMap=new Map(),derivedTasks=new Map(),controls={};
  const classList=()=>{const values=new Set();return {toggle(name,force){const on=force??!values.has(name);if(on)values.add(name);else values.delete(name);return on;},remove(name){values.delete(name);}};};
  class Element{
    constructor(tag='',attrs={}){this.tag=tag;this.attrs=attrs;this.id=attrs.id;this.dataset=Object.fromEntries(Object.entries(attrs).filter(([key])=>key.startsWith('data-')).map(([key,value])=>[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase()),value]));this.classList=classList();this.isConnected=true;this.value='';}
    set innerHTML(value){this.html=value;if(this.id==='app')nodes=parse(value);else if(this.id==='list')nodes.push(...parse(value));}
    get innerHTML(){return this.html||'';}
    setAttribute(key,value){this.attrs[key]=value;}
    removeAttribute(key){delete this.attrs[key];}
    addEventListener(){}
    focus(){}
    querySelectorAll(selector){return document.querySelectorAll(selector);}
    prepend(node){nodes.unshift(node);}
  }
  function parse(html){return [...html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/g)].map(([,tag,attributes])=>{const attrs=Object.fromEntries([...attributes.matchAll(/([\w-]+)="([^"]*)"/g)].map(([,key,value])=>[key,value]));return new Element(tag,attrs);});}
  const app=new Element('main',{id:'app'}),shell=new Element('div'),navigation=new Element('nav');
  const navs=['capture','videos','profile'].map(value=>new Element('button',{'data-nav':value}));
  const document={hidden:false,querySelector(selector){if(selector==='#app')return app;if(selector==='.shell')return shell;if(selector==='nav')return navigation;return this.querySelectorAll(selector)[0]||null;},querySelectorAll(selector){if(selector==='[data-nav]')return navs;if(selector.startsWith('#'))return nodes.filter(node=>node.id===selector.slice(1));if(selector.startsWith('.'))return nodes.filter(node=>(node.attrs.class||'').split(' ').includes(selector.slice(1)));const attr=/^\[([^=\]]+)(?:="([^"]+)")?\]$/.exec(selector);if(attr)return nodes.filter(node=>attr[1] in node.attrs&&(attr[2]===undefined||node.attrs[attr[1]]===attr[2]));return nodes.filter(node=>selector.split(',').includes(node.tag));},addEventListener(){},createElement(tag){return new Element(tag);}};
  const location={hash:''};const window={history:{pushState(a,b,hash){location.hash=hash;}},addEventListener(){}};
  async function api(url,options={}){
    if(url==='/api/health')return {liveEnabled:live,...healthData};
    if(url==='/api/tasks'&&options.method==='POST'){
      const data=structuredClone(options.data);requests.push(data);const capability=getCapability(data.capability),id=randomUUID();
      const task={id,capability:capability.id,status:'completed',mode:data.sampleId?'sample':'live',delivery:data.delivery,created:Date.now(),title:capability.sampleLabel,result:{format:capability.kind==='interactive'?'interactive':'lesson',audioReady:false,videoReady:false,title:capability.sampleLabel,problem:data.text||capability.sampleProblem,answer:'已核对的答案',steps:[{title:'分析条件',description:'对照图形检查条件。'}],preview:'/artifact/lesson.html',download:'/artifact/download.html',}};
      taskMap.set(id,task);return task;
    }
    if(url.endsWith('/narration')){
      const sourceId=url.split('/')[3];derivedRequests.push({action:'narration',sourceId,...options});
      if(controls.narrationGate)await controls.narrationGate;
      if(controls.narrationError)throw controls.narrationError;
      if(derivedTasks.has(sourceId))return derivedTasks.get(sourceId);
      const original=taskMap.get(sourceId),id=randomUUID();
      const task={...original,id,mode:'narration',delivery:'video',sourceTaskId:sourceId,narrationOf:sourceId,sourceMode:original.sourceMode||original.mode,result:{...original.result,format:'video',audioReady:true,videoReady:false,subtitles:'/artifact/subtitles.srt'}};
      taskMap.set(id,task);derivedTasks.set(sourceId,task);return task;
    }
    if(url.endsWith('/export')){
      const sourceId=url.split('/')[3];derivedRequests.push({action:'export',sourceId,...options});
      if(controls.exportGate)await controls.exportGate;
      if(controls.exportError)throw controls.exportError;
      const original=taskMap.get(sourceId),id=randomUUID(),task={...original,id,mode:'export',sourceTaskId:original.sourceTaskId||sourceId,sourceMode:original.sourceMode||original.mode,status:'running',stage:'rendering',result:undefined};
      taskMap.set(id,task);return task;
    }
    if(url==='/api/tasks')return {tasks:[...taskMap.values()]};
    return taskMap.get(url.split('/')[3]);
  }
  const context=vm.createContext({document,window,location,navigator:{onLine:true,clipboard:{writeText:async()=>{}}},crypto:{randomUUID},createClient:()=>api,editPhoto:async()=>null,formatMath,...ui,CAPABILITIES,DEFAULT_CAPABILITY,getCapability,setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},Date,console});
  vm.runInContext(source,context);
  return {context,app,document,requests,derivedRequests,taskMap,controls,location,async click(selector){const node=document.querySelector(selector);assert.ok(node,`missing ${selector}`);assert.equal(typeof node.onclick,'function',`${selector} must respond`);await node.onclick({currentTarget:node});},select(id){return this.click(`[data-capability="${id}"]`);},async settle(){await new Promise(resolve=>setImmediate(resolve));}};
}

test('all six modes default to silent lessons with an explicit narration action',async()=>{
  const h=harness();await h.settle();
  assert.equal(CAPABILITIES.length,6);assert.equal(new Set(CAPABILITIES.map(c=>c.id)).size,6);
  for(const capability of CAPABILITIES){
    await h.select(capability.id);await h.click('#sample');
    const request=h.requests.at(-1);assert.equal(request.capability,capability.id);assert.equal(request.sampleId,capability.id===DEFAULT_CAPABILITY?'equation':'default');
    assert.equal(request.delivery,'lesson');assert.equal(h.document.querySelector('#export-result'),null);assert.ok(h.document.querySelector('#narrate-result'));
    if(capability.kind==='interactive'){
      assert.match(h.app.innerHTML,/<iframe[^>]*sandbox="allow-scripts"/);assert.doesNotMatch(h.app.innerHTML,/allow-same-origin|<video/);assert.match(h.app.innerHTML,/下载交互网页/);assert.doesNotMatch(h.app.innerHTML,/data-seek=/);
    }else{assert.equal(request.exportVideo,false);assert.match(h.app.innerHTML,/<iframe[^>]*sandbox="allow-scripts"/);assert.doesNotMatch(h.app.innerHTML,/<video|data-seek=|下载字幕/);assert.match(h.app.innerHTML,/无配音讲解/);}
    await h.click('#again');
  }
  h.context.nav('videos');await h.settle();
  assert.equal(h.document.querySelectorAll('[data-task]').length,6);
  assert.match(h.document.querySelector('#list').innerHTML,/交互讲解/);
  h.document.querySelector('#search').oninput({target:{value:'化学反应'}});
  assert.equal([...h.document.querySelector('#list').innerHTML.matchAll(/data-task=/g)].length,1);
  assert.match(h.document.querySelector('#list').innerHTML,/甲烷燃烧与原子守恒/);
  assert.doesNotMatch(h.document.querySelector('#list').innerHTML,/牛顿第二定律/);
});

test('text input is preserved across mode changes, sent without a photo, and safely displayed',async()=>{
  const h=harness();await h.settle();const problem='求解 x < 2，<script>alert(1)</script>';
  const input=h.document.querySelector('#problem');input.oninput({target:{value:problem}});
  await h.select('analytic-geometry');assert.match(h.app.innerHTML,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  await h.click('#submit');assert.equal(h.requests[0].text,problem);assert.equal(h.requests[0].image,undefined);assert.equal(h.requests[0].sampleId,undefined);assert.match(h.app.innerHTML,/&lt;script&gt;/);assert.doesNotMatch(h.app.innerHTML,/<script>/);
});

test('random actions are limited to the three interactive built-in libraries',async()=>{
  const h=harness();await h.settle();
  for(const capability of CAPABILITIES){await h.select(capability.id);assert.equal(!!h.document.querySelector('#random-sample'),capability.random);if(capability.random){await h.click('#random-sample');assert.equal(h.requests.at(-1).sampleId,'random');assert.equal(h.requests.at(-1).capability,capability.id);await h.click('#again');}}
});

test('every module follows lesson to narrated HTML to a separate MP4 task without solving again',async()=>{
  for(const capability of CAPABILITIES){
    const h=harness();await h.settle();await h.select(capability.id);await h.click('#sample');
    const original=h.taskMap.get(h.location.hash.split('/')[1]),sourceHash=h.location.hash;
    assert.equal(original.result.audioReady,false);assert.equal(h.document.querySelector('#export-result'),null);
    await h.click('#narrate-result');
    const narration=h.taskMap.get(h.location.hash.split('/')[1]);
    assert.notEqual(h.location.hash,sourceHash);assert.equal(narration.mode,'narration');assert.equal(narration.narrationOf,original.id);
    assert.equal(narration.sourceMode,'sample');assert.equal(narration.result.audioReady,true);assert.equal(narration.result.videoReady,false);
    assert.equal(narration.result.answer,original.result.answer);assert.equal(narration.result.problem,original.result.problem);
    assert.match(h.app.innerHTML,/<iframe/);assert.doesNotMatch(h.app.innerHTML,/<video/);assert.ok(h.document.querySelector('#export-result'));assert.equal(h.document.querySelector('#narrate-result'),null);
    assert.match(h.app.innerHTML,/查看原始讲解/);assert.equal(h.requests.length,1);
    assert.deepEqual(h.derivedRequests.map(r=>r.action),['narration']);assert.equal(h.derivedRequests[0].data,undefined);
    const narrationHash=h.location.hash;await h.click('#export-result');
    assert.notEqual(h.location.hash,narrationHash);const exported=h.taskMap.get(h.location.hash.split('/')[1]);assert.equal(exported.mode,'export');
    assert.match(h.app.innerHTML,/正在导出视频/);assert.doesNotMatch(h.app.innerHTML,/识别题目|解题与复核/);assert.equal(h.requests.length,1);
    assert.deepEqual(h.derivedRequests.map(r=>r.action),['narration','export']);
  }
});

test('pending narration blocks repeated clicks and restores the action after a request error',async()=>{
  const h=harness();await h.settle();await h.click('#sample');
  let release;h.controls.narrationGate=new Promise(resolve=>{release=resolve;});
  h.controls.narrationError=new Error('配音连接失败，请重试。');
  const pending=h.click('#narrate-result');assert.equal(h.document.querySelector('#narrate-result').disabled,true);
  await h.click('#narrate-result');assert.equal(h.derivedRequests.length,1);
  release();await pending;assert.equal(h.document.querySelector('#narrate-result').disabled,false);
  assert.equal(h.document.querySelector('#narrate-result').textContent,'生成配音讲解');
  assert.match(h.document.querySelector('#error').textContent,/配音连接失败/);
  delete h.controls.narrationGate;delete h.controls.narrationError;
  await h.click('#narrate-result');assert.equal(h.derivedRequests.length,2);assert.ok(h.document.querySelector('#export-result'));
});

test('pending MP4 requests block repeats and recover after export errors',async()=>{
  const h=harness();await h.settle();await h.click('#sample');await h.click('#narrate-result');
  let release;h.controls.exportGate=new Promise(resolve=>{release=resolve;});h.controls.exportError=new Error('导出连接失败');
  const pending=h.click('#export-result');await h.click('#export-result');assert.equal(h.derivedRequests.filter(r=>r.action==='export').length,1);
  assert.equal(h.document.querySelector('#export-result').disabled,true);release();await pending;
  assert.equal(h.document.querySelector('#export-result').disabled,false);assert.equal(h.document.querySelector('#export-result').textContent,'导出 MP4 视频');
});

test('closed paid stages and exhausted cumulative budget still allow sample narration and render-only export',async()=>{
  const h=harness({live:false,healthData:{stages:{lesson:{available:false,reason:'PROJECT_BUDGET_EXHAUSTED',reserveCents:100},narration:{available:false,reason:'NARRATION_LIMIT',reserveCents:200}},budget:{currency:'CNY',kind:'cumulative-reservation',limitCents:2000,reservedCents:2000,remainingCents:0}}});
  await h.settle();const status=h.document.querySelector('[data-service-status]').innerHTML;assert.match(status,/项目累计预留/);assert.match(status,/¥20.00/);assert.match(status,/供应商实际账单/);
  h.document.querySelector('#problem').oninput({target:{value:'2x + 3 = 11'}});await h.click('#submit');assert.equal(h.requests.length,0);assert.match(h.document.querySelector('#error').textContent,/项目累计预留额度已满/);
  await h.click('#sample');await h.click('#narrate-result');await h.click('#export-result');
  assert.equal(h.requests.length,1);assert.deepEqual(h.derivedRequests.map(r=>r.action),['narration','export']);
});

test('legacy MP4 and narrated previews remain playable and exportable',async()=>{
  const h=harness({live:false});await h.settle();
  const legacy={id:randomUUID(),status:'completed',capability:'math-video',title:'旧讲解',result:{title:'旧讲解',answer:'4',video:'/old.mp4',steps:[{title:'旧步骤',description:'旧答案'}]}};
  h.taskMap.set(legacy.id,legacy);await h.context.showTask(legacy.id);assert.match(h.app.innerHTML,/<video[^>]*src="\/old.mp4"/);assert.equal(h.document.querySelector('#narrate-result'),null);
  const preview={...legacy,id:randomUUID(),result:{...legacy.result,video:undefined,format:'video',preview:'/old.html'}};
  h.taskMap.set(preview.id,preview);await h.context.showTask(preview.id);assert.ok(h.document.querySelector('#export-result'));assert.equal(h.document.querySelector('#narrate-result'),null);await h.click('#export-result');assert.equal(h.derivedRequests.at(-1).action,'export');
});


test('interactive progress never promises speech and old MP4-only results remain video',()=>{
  for(const capability of CAPABILITIES.filter(c=>c.kind==='interactive')){
    assert.deepEqual(ui.taskSteps({capability:capability.id}),['读取题目','解题与复核','制作交互讲解']);assert.equal(ui.taskPhase({capability:capability.id,status:'running',stage:'rendering'}).index,2);
  }
  assert.equal(ui.resultFormat({result:{video:'/old.mp4'}}),'video');assert.equal(ui.resultFormat({result:{format:'interactive'}}),'interactive');assert.deepEqual(ui.taskSteps({mode:'export'}),['导出视频']);
});

test('closed live access still permits module examples and blocks text generation',async()=>{
  const h=harness({live:false});await h.settle();h.document.querySelector('#problem').oninput({target:{value:'2x + 3 = 11'}});await h.click('#submit');assert.equal(h.requests.length,0);assert.match(h.document.querySelector('#error').textContent,/尚未开通/);await h.select('chem-reaction');await h.click('#sample');assert.equal(h.requests.length,1);
});
