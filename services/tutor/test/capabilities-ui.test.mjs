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
function harness({live=true}={}){
  let nodes=[];const requests=[],taskMap=new Map();
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
    if(url==='/api/health')return {liveEnabled:live};
    if(url==='/api/tasks'&&options.method==='POST'){
      const data=structuredClone(options.data);requests.push(data);const capability=getCapability(data.capability),id=randomUUID();
      const task={id,capability:capability.id,status:'completed',mode:data.sampleId?'sample':'live',created:Date.now(),title:capability.sampleLabel,result:{format:capability.kind,title:capability.sampleLabel,problem:data.text||capability.sampleProblem,answer:'已核对的答案',steps:[{title:'分析条件',description:'对照图形检查条件。'}],preview:'/artifact/lesson.html',download:'/artifact/download.html',...(capability.kind==='video'?{subtitles:'/artifact/subtitles.srt',...(data.exportVideo!==false?{video:'/artifact/video.mp4',duration:40}:{})}:{})}};
      taskMap.set(id,task);return task;
    }
    if(url.endsWith('/export')){const original=taskMap.get(url.split('/')[3]),id=randomUUID(),task={...original,id,mode:'export',status:'running',stage:'rendering',result:undefined};taskMap.set(id,task);return task;}
    if(url==='/api/tasks')return {tasks:[...taskMap.values()]};
    return taskMap.get(url.split('/')[3]);
  }
  const context=vm.createContext({document,window,location,navigator:{onLine:true,clipboard:{writeText:async()=>{}}},crypto:{randomUUID},createClient:()=>api,editPhoto:async()=>null,formatMath,...ui,CAPABILITIES,DEFAULT_CAPABILITY,getCapability,setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},Date,console});
  vm.runInContext(source,context);
  return {context,app,document,requests,taskMap,location,async click(selector){const node=document.querySelector(selector);assert.ok(node,`missing ${selector}`);assert.equal(typeof node.onclick,'function',`${selector} must respond`);await node.onclick({currentTarget:node});},select(id){return this.click(`[data-capability="${id}"]`);},async settle(){await new Promise(resolve=>setImmediate(resolve));}};
}

test('all six modes submit their own built-in examples and render the correct output format',async()=>{
  const h=harness();await h.settle();
  assert.equal(CAPABILITIES.length,6);assert.equal(new Set(CAPABILITIES.map(c=>c.id)).size,6);
  for(const capability of CAPABILITIES){
    await h.select(capability.id);await h.click('#sample');
    const request=h.requests.at(-1);assert.equal(request.capability,capability.id);assert.equal(request.sampleId,capability.id===DEFAULT_CAPABILITY?'equation':'default');
    if(capability.kind==='interactive'){
      assert.match(h.app.innerHTML,/<iframe[^>]*sandbox="allow-scripts"/);assert.doesNotMatch(h.app.innerHTML,/allow-same-origin|<video/);assert.match(h.app.innerHTML,/下载交互网页/);assert.doesNotMatch(h.app.innerHTML,/data-seek=/);
    }else{assert.match(h.app.innerHTML,/<video[^>]*src="\/artifact\/video.mp4"/);assert.match(h.app.innerHTML,/下载字幕/);assert.match(h.app.innerHTML,/data-seek="0"/);}
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

test('preview-first video exports follow the returned task id without pretending to solve again',async()=>{
  const h=harness();await h.settle();h.document.querySelector('#export-video').onchange({target:{checked:false}});await h.click('#sample');
  assert.equal(h.requests[0].exportVideo,false);assert.match(h.app.innerHTML,/<iframe/);assert.doesNotMatch(h.app.innerHTML,/<video/);const sourceHash=h.location.hash;
  await h.click('#export-result');assert.notEqual(h.location.hash,sourceHash);const exported=h.taskMap.get(h.location.hash.split('/')[1]);assert.equal(exported.mode,'export');assert.match(h.app.innerHTML,/正在导出视频/);assert.doesNotMatch(h.app.innerHTML,/生成配音|识别题目|解题与复核/);
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
