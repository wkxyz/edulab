import {createClient} from './api-client.mjs';
import {chapterStarts, formatTime, photoError, taskPhase, taskSteps, resultFormat, hasNarration, resultActions, projectBudgetText} from './ui.mjs';
import {CAPABILITIES, DEFAULT_CAPABILITY, getCapability} from './capabilities.mjs';
import {editPhoto} from './photo-editor.mjs';
import {formatMath} from './math-format.mjs';

const app = document.querySelector('#app');
let current='capture', taskId='', timer, clock, photo, busy=false, epoch=0, selectionId=0;
let createKey=crypto.randomUUID(), health, healthPending, healthChecked=0, healthError=false;
let tasks=[], filter='all', search='', taskViewKey='';
let capabilityId=DEFAULT_CAPABILITY, problemText='', boardStyle='chalk', createPayload='';
const derivedPending=new Set();
const styleLabels={chalk:'绿板粉笔',lab:'实验室',whiteboard:'白板',notebook:'笔记本',handdrawn:'手绘动画'};
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = name => `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true">${{
  camera:'<path d="M3 7h5l2-3h4l2 3h5v13H3z"/><circle cx="12" cy="13" r="4"/>',
  play:'<path d="m9 5 11 7-11 7z"/>', crop:'<path d="M6 3v15h15M3 6h15v15"/>',
  check:'<path d="m5 12 4 4L19 6"/>', arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
  book:'<path d="M12 5v15M3 4c4-1 7 0 9 2 2-2 5-3 9-2v15c-4-1-7 0-9 2-2-2-5-3-9-2z"/>',
}[name]||''}</svg>`;
const errors={PROVIDER_TIMEOUT:'解题或配音服务响应超时，本次任务已结束，系统不会自动重试。',PROVIDER_FAILED:'解题或配音服务暂时不可用，本次任务已结束，系统不会自动重试。',LIVE_LIMIT:'本站试用次数已用完，仍可查看内置示例。需要管理员设置新次数后继续。',NOT_CONFIGURED:'真实解题服务尚未开通，可先体验示例讲解。',STOPPED:'服务已暂停，请稍后再试。',OWNER_LIMIT:'今天的体验次数已用完。',PROJECT_LIMIT:'今天的生成额度已用完。',TOTAL_LIMIT:'体验服务容量已满。',QUEUE_FULL:'当前排队较多，请稍后再试。',BUDGET_EXHAUSTED:'今天的服务额度已用完。',INVALID_IMAGE:'图片格式不正确，请重新选择。',REVIEW_FAILED:'解答未通过复核，请重新拍摄完整题目。',INVALID_LESSON:'暂时无法可靠讲解这道题，请重新拍摄。',CANCELLED:'任务已取消。',TIMEOUT:'本次生成超时，请稍后重试。',EXPIRED:'任务已过期。',INTERRUPTED:'服务重启，本次任务已停止，可重新提交。',INVALID_CAPABILITY:'请选择一种支持的学习方式。',INVALID_STYLE:'请选择该模块支持的板书风格。',INVALID_INPUT:'请输入题目文字或上传一道题。',INVALID_TEXT:'请检查题目文字长度和内容。',INVALID_SAMPLE:'该模块没有这个内置示例，请重新选择。'};
const api=createClient({message:code=>errors[code]||'暂时无法完成，请稍后重试。'});
Object.assign(errors,{UNBALANCED_EQUATION:'化学方程式未通过原子或电荷守恒检查，本次已停止。',UNBALANCED_ELECTRONS:'电子转移未通过守恒检查，本次已停止。',INTERACTIVE_DEPENDENCY_MISSING:'交互讲解服务暂时不可用，请稍后再试。',INTERACTIVE_RENDER_FAILED:'交互页面制作未完成，本次已停止。',UNSUPPORTED_PROBLEM:'暂不支持这道题的可靠讲解，请换一道题或体验内置示例。',INVALID_INTERACTIVE_SPEC:'交互图形未通过检查，请换一道题或体验内置示例。',INVALID_ANIMATION:'动画讲解未通过检查，请换一道题或体验内置示例。',EXPORT_NOT_AVAILABLE:'当前讲解无法导出视频，请查看网页讲解。',ARTIFACT_EXPIRED:'讲解文件已过期，暂时无法打开。'});

Object.assign(errors,{
  PROJECT_BUDGET_EXHAUSTED:'项目累计预留额度已满。历史预留会保留，内置示例与示例配音仍可使用。',
  LESSON_LIMIT:'真实解答阶段次数已用完，仍可体验内置示例。',
  NARRATION_LIMIT:'真实配音阶段次数已用完，仍可阅读已有讲解或体验示例配音。',
  LESSON_DAILY_LIMIT:'今天的真实解答次数已用完，仍可体验内置示例。',
  NARRATION_DAILY_LIMIT:'今天的真实配音次数已用完，仍可阅读已有讲解或体验示例配音。',
  NARRATION_NOT_AVAILABLE:'当前任务无法生成配音，请先完成题目讲解。',
  SOURCE_NOT_READY:'来源讲解尚未完成，请完成后再生成配音。',
});
function showError(error){
  let box=document.querySelector('#error');
  if(!box){box=document.createElement('div');box.id='error';box.className='error';box.setAttribute('role','alert');app.prepend(box);}
  box.textContent=error.message||'连接失败，请检查网络。';box.hidden=false;
}
function clearTimers(){clearTimeout(timer);clearInterval(clock);}
function setNavigation(tab){document.querySelectorAll('[data-nav]').forEach(button=>{const selected=button.dataset.nav===tab;button.classList.toggle('selected',selected);if(selected)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});}
function routeHash(hash){if(location.hash!==hash)window.history.pushState(null,'',hash);}
function nav(tab){
  clearTimers();epoch++;current=tab;taskViewKey='';routeHash('#'+tab);setNavigation(tab);
  document.querySelector('.shell').classList.remove('wide-player');
  if(tab==='capture')capture();if(tab==='videos')history();if(tab==='profile')profile();
}
async function showTask(id){
  clearTimers();epoch++;taskId=id;current='task';taskViewKey='';routeHash('#task/'+id);setNavigation('videos');
  app.innerHTML='<div class="loading-panel" role="status"><span class="spinner"></span><p>正在加载讲解…</p></div>';await loadTask();
}
document.querySelector('nav').addEventListener('click',event=>{const button=event.target.closest('[data-nav]');if(button)nav(button.dataset.nav);});

function healthText(){
  if(!navigator.onLine)return {title:'当前网络已断开',detail:'请连接网络后继续，已填写的题目会保留在当前页面。',kind:'offline'};
  if(healthError)return {title:'暂时无法连接讲解服务',detail:'请检查网络后重试，题目会保留在当前页面。',kind:'offline'};
  if(!health)return {title:'正在连接讲解服务',detail:'可先选好一道清晰、完整的题目。',kind:'connecting'};
  if(health.stopped)return {title:'服务暂时暂停',detail:'请稍后再试，讲解记录会保留。',kind:'offline'};
  const stage=health.stages?.lesson;
  if(stage?.available===false)return {title:stage.reason==='PROJECT_BUDGET_EXHAUSTED'?'项目累计预留额度已满':'真实解答暂不可用',detail:errors[stage.reason]||'仍可体验内置示例，已有讲解会保留。',kind:'sample'};
  if(health.liveLimitReached)return {title:'真实解题体验额度已用完',detail:'可继续体验内置示例，等待服务方开放更多额度。',kind:'sample'};
  if(!health.liveEnabled)return {title:'示例体验中',detail:'真实解题暂未开放。可编辑题目、调整图片，或体验各模块的内置示例。',kind:'sample'};
  return {title:'讲解服务已开启',detail:'先生成文字或交互讲解，再按需生成配音与 MP4。每次一道题，图片不超过 4MB。',kind:'live'};
}
function healthDetails(){
  if(!health)return '';
  const budget=projectBudgetText(health.budget);
  const stages=['lesson','narration'].filter(name=>health.stages?.[name]).map(name=>{
    const stage=health.stages[name],label=name==='lesson'?'解答':'配音';
    const reserve=Number.isFinite(stage.reserveCents)?'，每次预留 ¥'+(Math.max(0,stage.reserveCents)/100).toFixed(2):'';
    return label+'：'+(stage.available?'可用'+reserve:errors[stage.reason]||'暂不可用');
  }).join('；');
  return (stages?'<p class="tiny muted">'+esc(stages)+'</p>':'')+(budget?'<p class="tiny muted">'+esc(budget)+'</p>':'');
}
function updateHealthUI(){const info=healthText(),box=document.querySelector('[data-service-status]');if(box){box.dataset.kind=info.kind;box.innerHTML=`<span class="status-dot"></span><div><strong>${info.title}</strong><p>${info.detail}</p>${healthDetails()}</div>`;}}
async function checkHealth(force=false){
  if(!force&&health&&Date.now()-healthChecked<30000)return health;
  if(!healthPending)healthPending=api('/api/health',{auth:false}).then(value=>{health=value;healthError=false;healthChecked=Date.now();return value;}).catch(()=>{healthError=true;return null;}).finally(()=>{healthPending=null;updateHealthUI();});
  return healthPending;
}
function capture(){
  const info=healthText(),capability=getCapability(capabilityId),interactive=capability.kind==='interactive';
  app.innerHTML=`<div class="page-intro"><span class="eyebrow">让思路看得见</span><h1>拍一道题，听懂每一步</h1><p class="sub">先读文字与交互讲解，理解后可按需生成配音，再导出 MP4。</p></div>
    <section class="panel capability-panel" aria-labelledby="capability-heading"><div class="section-heading"><h2 id="capability-heading">选择学习方式</h2><span class="mini-label">3 种交互 · 3 种视频</span></div><div class="capability-grid" role="group" aria-label="学习方式">${CAPABILITIES.map(item=>`<button class="capability-choice ${item.id===capabilityId?'selected':''}" data-capability="${item.id}" aria-pressed="${item.id===capabilityId}"><span>${esc(item.title)}</span><small>${item.kind==='interactive'?'交互探索':'分步讲解'}</small></button>`).join('')}</div><p class="capability-detail" id="capability-detail">${esc(capability.description)}</p></section>
    <div class="capture-grid"><section class="panel upload-panel" aria-label="输入题目"><div class="section-heading"><h2>输入一道题</h2><span class="mini-label">${esc(capability.title)}</span></div>
    <div class="service-status" data-service-status data-kind="${info.kind}"><span class="status-dot"></span><div><strong>${info.title}</strong><p>${info.detail}</p>${healthDetails()}</div></div>
    <label class="problem-label" for="problem">题目文字 <span class="mini-label">也可以只上传图片</span></label><textarea id="problem" name="text" maxlength="6000" rows="4" placeholder="输入完整题目、已知条件和想解决的问题…" aria-describedby="problem-help">${esc(problemText)}</textarea><p class="tiny muted" id="problem-help">文字与图片可一起提交。每次一道题，保留必要的条件和图形。</p>
    <input id="file" type="file" accept="image/png,image/jpeg,image/webp" aria-label="上传题目图片" hidden>
    ${photo?`<div class="photo-card"><img class="photo-preview" src="${esc(photo.image)}" alt="已选题目" data-cropped="${!!photo.cropped}"><div class="photo-caption"><span>${esc(photo.name)}</span>${photo.cropped?'<span class="badge success">已调整</span>':''}</div></div><div class="photo-actions"><button class="small-button" id="edit-photo">${icon('crop')}裁剪 / 旋转</button><button class="small-button" id="choose">重新选择</button><button class="text-button" id="remove-photo">移除图片</button>${photo.cropped?'<button class="text-button" id="restore-photo">还原原图</button>':''}</div><p class="muted upload-help">确认整道题清楚、完整，包含题干、条件和图形。</p>`:
    `<button class="upload" id="choose">${icon('camera')}<strong>拍照 / 选择图片</strong><span>或将图片拖到这里</span><small>支持粘贴截图 · PNG / JPEG / WebP · 最大 4MB</small></button>`}
    ${capability.styles.length>1?`<label class="style-field" for="board-style"><span>板书风格</span><select id="board-style">${capability.styles.map(style=>`<option value="${style}" ${style===boardStyle?'selected':''}>${styleLabels[style]}</option>`).join('')}</select></label>`:capabilityId==='physics-video'?'<p class="muted tiny">动画风格：蓝图式物理示意图。</p>':capabilityId==='chem-video'?'<p class="muted tiny">动画风格：黑板反应式与粒子示意图。</p>':''}
    <p class="muted tiny">默认生成无配音讲解。完成后可点击“生成配音讲解”，再按需导出 MP4。</p>
    <button class="btn" id="submit">${interactive?'生成交互讲解':'生成文字讲解'}${icon('arrow')}</button>
    <div id="error" class="error" role="alert" hidden></div><p class="privacy-note">${icon('check')}点击生成后才会提交题目，图片裁剪在你的浏览器内完成。</p></section>
    <aside class="capture-aside"><section class="panel sample-panel"><span class="eyebrow">先看一个完整示例</span><h2>${capabilityId==='math-video'?'一道方程，三步讲明白':esc(capability.sampleLabel)}</h2><p class="muted">${esc(capability.description)}</p><button class="sample" id="sample-row"><span class="mini-label">${esc(capability.sampleLabel)} · 内置示例</span><span class="${capabilityId==='math-video'?'formula':'sample-problem'}">${esc(capability.sampleProblem)}</span><span class="sample-answer">${interactive?'打开交互图形，逐步观察与验证。':'从哪里开始？为什么这样算？'}</span></button><button class="btn" id="sample">${icon('play')}体验示例讲解</button>${capability.random?'<button class="small-button random-example" id="random-sample">换一个内置题例</button>':''}<p class="muted tiny">${interactive?'内置题例 · 不消耗真实解题次数':'固定题目 · 内置讲解 · 示例配音免费'}</p>${capability.random?'<p class="tiny muted">随机从本模块内置题库选择，不会生成任意新题。</p>':''}</section><section class="panel tips-panel"><h2>${interactive?'探索时可以做什么':'怎样拍得更清楚'}</h2><ol>${interactive?'<li>跟着步骤梳理已知条件</li><li>旋转视角或调整图形参数</li><li>对照答案，检查每一步推导</li>':'<li>一次只保留一道题</li><li>题干、选项和图形都拍完整</li><li>尽量正对纸面，避开阴影</li>'}</ol></section></aside></div><p class="footer">AI 讲解仅供学习参考，请结合教材核对。</p>`;
  document.querySelectorAll('[data-capability]').forEach(button=>button.onclick=()=>{capabilityId=button.dataset.capability;const next=getCapability(capabilityId);if(next.styles.length&&!next.styles.includes(boardStyle))boardStyle=next.styles[0];createKey=crypto.randomUUID();capture();document.querySelector(`[data-capability="${capabilityId}"]`).focus();});
  document.querySelector('#problem').oninput=event=>{problemText=event.target.value;createKey=crypto.randomUUID();};
  const styleControl=document.querySelector('#board-style');if(styleControl)styleControl.onchange=event=>{boardStyle=event.target.value;createKey=crypto.randomUUID();};
  document.querySelector('#choose').onclick=()=>document.querySelector('#file').click();
  document.querySelector('#file').onchange=event=>acceptFile(event.target.files[0]);
  document.querySelector('#submit').onclick=()=>{const text=problemText.trim();if(!text&&!photo)return showError(new Error('请输入题目文字或上传一道题。'));start({capability:capabilityId,...(text?{text}:{}),...(photo?{image:photo.image}:{}),delivery:'lesson',...(!interactive?{style:boardStyle,exportVideo:false}:{})});};
  if(photo){
    document.querySelector('#edit-photo').onclick=async()=>{const version=epoch,selected=photo;try{const result=await editPhoto(photo.image);if(result&&current==='capture'&&epoch===version&&photo===selected){photo={...photo,...result,cropped:true};createKey=crypto.randomUUID();capture();}}catch(error){if(current==='capture')showError(error);}};
    document.querySelector('#remove-photo').onclick=()=>{photo=undefined;createKey=crypto.randomUUID();capture();};
    const restore=document.querySelector('#restore-photo');if(restore)restore.onclick=()=>{photo={...photo,image:photo.original,cropped:false};createKey=crypto.randomUUID();capture();};
  }
  document.querySelector('#sample').onclick=document.querySelector('#sample-row').onclick=()=>start({capability:capabilityId,sampleId:capabilityId==='math-video'?'equation':'default',delivery:'lesson',...(!interactive?{style:boardStyle,exportVideo:false}:{})});
  const random=document.querySelector('#random-sample');if(random)random.onclick=()=>start({capability:capabilityId,sampleId:'random',delivery:'lesson'});
  const upload=document.querySelector('.upload-panel');
  upload.ondragover=event=>{event.preventDefault();upload.classList.add('drag-over');};
  upload.ondragleave=event=>{if(!upload.contains(event.relatedTarget))upload.classList.remove('drag-over');};
  upload.ondrop=event=>{event.preventDefault();upload.classList.remove('drag-over');if(!busy)acceptFile(event.dataTransfer.files[0]);};checkHealth();
}
async function acceptFile(file){
  if(!file||busy)return;const error=photoError(file);if(error)return showError(new Error(error));const version=epoch,request=++selectionId;
  try{const image=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('无法读取图片，请重新选择。'));reader.readAsDataURL(file);});
    if(current!=='capture'||epoch!==version||request!==selectionId)return;
    photo={image,original:image,name:file.name||'粘贴的截图',cropped:false};createKey=crypto.randomUUID();capture();
  }catch(error){if(current==='capture'&&epoch===version)showError(error);}
}
document.addEventListener('paste',event=>{if(current!=='capture'||document.querySelector('dialog[open]')||busy||event.target.closest?.('input,textarea,[contenteditable="true"]'))return;const item=[...(event.clipboardData?.items||[])].find(item=>item.type.startsWith('image/'));if(item){event.preventDefault();acceptFile(item.getAsFile());}});
async function start(data){
  if(busy)return;if(!navigator.onLine)return showError(new Error('网络已断开，请连接后重试。'));
  if(!data.sampleId&&health){
    const stage=health.stages?.lesson;
    const reason=health.stopped?'STOPPED':stage?.available===false?stage.reason:!health.liveEnabled?(health.liveLimitReached?'LIVE_LIMIT':'NOT_CONFIGURED'):'';
    if(reason)return showError(new Error(errors[reason]||'真实解答暂不可用，可先体验内置示例。'));
  }
  const payload=JSON.stringify(data);if(createPayload!==payload){createKey=crypto.randomUUID();createPayload=payload;}
  busy=true;const version=epoch,active=document.querySelector(data.sampleId==='random'?'#random-sample':data.sampleId?'#sample':'#submit'),label=active?.innerHTML;
  app.querySelectorAll('button,input,textarea,select').forEach(control=>control.disabled=true);if(active)active.textContent='正在提交…';
  try{const task=await api('/api/tasks',{method:'POST',data,key:createKey});createKey=crypto.randomUUID();if(epoch===version)await showTask(task.id);}
  catch(error){if(epoch===version)showError(error);}
  finally{busy=false;if(active?.isConnected)active.innerHTML=label;app.querySelectorAll('button,input,textarea,select').forEach(control=>control.disabled=false);}
}

function history(){
  app.innerHTML=`<div class="page-intro compact"><span class="eyebrow">每次思考，都有迹可循</span><h1>我的讲解</h1><p class="sub">回看文字、交互、配音与视频讲解，随时回来复习。</p></div><section class="panel history-panel"><div class="history-toolbar"><div class="filters" aria-label="讲解状态筛选"><button data-filter="all">全部</button><button data-filter="completed">已完成</button><button data-filter="active">生成中</button></div><label class="search-field"><span class="sr-only">搜索讲解</span><input id="search" type="search" placeholder="搜索题目" value="${esc(search)}"></label></div><div id="list" role="status"><div class="loading-panel"><span class="spinner"></span>正在加载讲解…</div></div><p class="history-note tiny muted">记录保存在当前浏览器会话。清除浏览器数据后可能无法找回。</p></section>`;
  document.querySelectorAll('[data-filter]').forEach(button=>button.onclick=()=>{filter=button.dataset.filter;renderHistory();});
  document.querySelector('#search').oninput=event=>{search=event.target.value;renderHistory();};refreshHistory();
}
async function refreshHistory(){
  const version=epoch;try{const result=await api('/api/tasks');if(current!=='videos'||epoch!==version)return;tasks=result.tasks;renderHistory();if(tasks.some(task=>['running','queued'].includes(task.status))&&!document.hidden)timer=setTimeout(refreshHistory,4000);}
  catch(error){if(current!=='videos'||epoch!==version)return;document.querySelector('#list').innerHTML=`<div class="empty"><p>${esc(error.message)}</p><button class="small-button" id="retry-history">重新加载</button></div>`;document.querySelector('#retry-history').onclick=refreshHistory;}
}
function renderHistory(){
  const list=document.querySelector('#list');if(!list)return;
  document.querySelectorAll('[data-filter]').forEach(button=>{const selected=button.dataset.filter===filter;button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));});
  const found=tasks.filter(task=>(filter==='all'||(filter==='active'?['running','queued'].includes(task.status):task.status===filter))&&`${task.title||''} ${getCapability(task.capability).title}`.toLowerCase().includes(search.trim().toLowerCase()));
  const labels={queued:'排队中',running:'生成中',completed:'已完成',failed:'生成失败',cancelled:'已取消'};
  list.innerHTML=found.length?`<div class="video-grid">${found.map(task=>`<button class="video-card" data-task="${esc(task.id)}"><div class="video-thumb">${task.result?.cover?`<img src="${esc(task.result.cover)}" alt="" loading="lazy">`:icon('book')}${resultFormat(task)==='interactive'?'<span class="duration-label">交互讲解</span>':task.result?.duration?`<span class="duration-label">${formatTime(task.result.duration)}</span>`:task.result?`<span class="duration-label">${hasNarration(task)?'配音讲解':'无配音讲解'}</span>`:''}</div><div class="video-card-body"><div class="card-badges"><span class="badge ${task.status==='completed'?'success':task.status==='failed'?'danger':'neutral'}">${labels[task.status]||'处理中'}</span><span class="mini-label">${esc(getCapability(task.capability).title)}${(task.mode==='sample'||task.sourceMode==='sample')?' · 内置示例':''}</span></div><strong>${esc(task.title)}</strong><span class="muted tiny">${new Date(task.created).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</span></div></button>`).join('')}</div>`:
    `<div class="empty">${icon('book')}<h2>${tasks.length?'没有找到匹配的讲解':'还没有讲解'}</h2><p>${tasks.length?'换个关键词或筛选条件试试。':'从一个完整示例开始，看看讲解是什么样的。'}</p>${tasks.length?'<button class="small-button" id="clear-filter">清除筛选</button>':'<button class="btn" id="empty-capture">去拍一道题</button>'}</div>`;
  document.querySelectorAll('[data-task]').forEach(button=>button.onclick=()=>showTask(button.dataset.task));
  const empty=document.querySelector('#empty-capture');if(empty)empty.onclick=()=>nav('capture');
  const clear=document.querySelector('#clear-filter');if(clear)clear.onclick=()=>{filter='all';search='';document.querySelector('#search').value='';renderHistory();};
}
async function profile(){
  app.innerHTML=`<div class="page-intro compact"><span class="eyebrow">安心使用，随时回看</span><h1>我的</h1></div><div class="profile-grid"><section class="panel"><h2>设备体验账号</h2><p class="muted">使用当前浏览器查看视频与交互讲解记录。</p><div class="service-status" data-service-status></div><button class="small-button" id="refresh-health">刷新服务状态</button></section><section class="panel"><h2>关于题解</h2><p class="muted">输入文字或上传图片，选择数理化交互探索或分步视频讲解。</p><div class="note">AI 输出可能有误，请结合教材核对。讲解用于辅助理解。</div><p class="muted tiny">跨设备账号登录和付费暂未开放。清除浏览器数据后可能无法找回历史记录。</p></section></div>`;
  updateHealthUI();document.querySelector('#refresh-health').onclick=()=>checkHealth(true);await checkHealth();
}

async function loadTask(){
  clearTimeout(timer);const id=taskId,version=epoch;
  try{const task=await api('/api/tasks/'+id);if(current!=='task'||taskId!==id||epoch!==version)return;
    const key=`${id}:${task.status}:${task.stage}:${task.error||''}:${task.result?.format||''}:${task.result?.audioReady??''}:${task.result?.video||''}`;
    if(key!==taskViewKey){taskViewKey=key;renderTask(task);}
    if(['queued','running'].includes(task.status)&&!document.hidden)timer=setTimeout(loadTask,2500);
  }catch(error){
    if(current!=='task'||taskId!==id||epoch!==version)return;taskViewKey='';
    app.innerHTML=`<button class="back" id="back" aria-label="返回我的视频">返回我的视频</button><section class="panel connection-panel"><h2>暂时无法连接</h2><p class="muted">${esc(error.message)}</p><p class="muted">任务记录会保留。重新连接只会查询进度，不会重复提交。</p><button class="btn" id="retry-task">重新连接</button></section>`;
    document.querySelector('#back').onclick=()=>nav('videos');document.querySelector('#retry-task').onclick=loadTask;
  }
}
function renderTask(task){
  clearInterval(clock);if(task.result)return renderResult(task);
  const terminal=['failed','cancelled'].includes(task.status),phase=taskPhase(task),interactive=getCapability(task.capability).kind==='interactive';
  app.innerHTML=`<button class="back" id="back" aria-label="返回我的视频">返回我的视频</button><div class="task-grid"><section class="panel progress-panel"><div class="section-heading"><span class="eyebrow">${esc(getCapability(task.capability).title)} · ${(task.mode==='sample'||task.sourceMode==='sample')?'内置示例':'你的题目'}</span><span class="badge neutral" id="elapsed"></span></div><h1>${esc(task.title)}</h1>${terminal?`<div class="task-notice"><h2>${task.status==='cancelled'?'本次生成已取消':'这次没有完成'}</h2><p class="error" role="alert">${esc(errors[task.error]||'本次生成未完成，请返回拍题页查看服务状态。')}</p><p class="muted">本次任务已结束，不会自动再次生成。可返回拍题页查看服务状态。</p><button class="btn" id="again">重新拍题</button></div>`:
    `<div class="current-phase" role="status"><span class="spinner"></span><div><h2>${phase.label}</h2><p class="muted">${phase.detail}</p></div></div><ol class="steps" aria-label="讲解生成进度">${taskSteps(task).map((label,index)=>`<li class="step ${index<phase.index?'done':index===phase.index?'active':''}"><span class="dot">${index<phase.index?icon('check'):index+1}</span><div><strong>${label}</strong><small>${index<phase.index?'已完成':index===phase.index?(phase.key==='queued'?'等待开始':'正在进行'):'等待中'}</small></div></li>`).join('')}</ol><div class="progress-actions"><button class="btn" id="history">查看我的视频</button><button class="text-button" id="cancel">取消本次生成</button></div>`}</section><aside class="panel waiting-panel"><span class="eyebrow">不必一直等在这里</span><h2>稍后回来，继续看懂这道题</h2><p class="muted">可以离开页面，在“视频”中查看进度。关闭浏览器不会取消服务器上的任务。</p><div class="note">${(task.mode==='sample'||task.sourceMode==='sample')?(interactive?'这是本模块的内置题例，将生成可操作的交互网页。':'这是本模块的固定题目示例，先生成无配音讲解，完成后可按需生成示例配音。'):'生成时间取决于题目和讲解长度，请耐心等待。'}</div></aside></div>`;
  document.querySelector('#back').onclick=()=>nav('videos');
  if(terminal)document.querySelector('#again').onclick=()=>nav('capture');
  else{
    const elapsed=()=>{const node=document.querySelector('#elapsed');if(node)node.textContent='已等待 '+formatTime((Date.now()-task.created)/1000);};elapsed();clock=setInterval(elapsed,1000);
    document.querySelector('#history').onclick=()=>nav('videos');
    document.querySelector('#cancel').onclick=async event=>{event.currentTarget.disabled=true;event.currentTarget.textContent='正在取消…';try{await api('/api/tasks/'+taskId+'/cancel',{method:'POST'});await loadTask();}catch(error){showError(error);const button=document.querySelector('#cancel');if(button){button.disabled=false;button.textContent='取消本次生成';}}};
  }
}
function renderResult(task){
  const result=task.result,steps=result.steps||[],starts=chapterStarts(result),interactive=resultFormat(task)==='interactive';
  const narrated=hasNarration(task),actions=resultActions(task),sourceId=task.sourceTaskId||task.narrationOf;
  const narrationPending=derivedPending.has(task.id+':narration'),exportPending=derivedPending.has(task.id+':export');
  const hasVideo=!!result.video,preview=result.preview||(!hasVideo?result.download:''),exporting=task.mode==='export'&&['running','queued'].includes(task.status);
  const iframe=(source,label)=>`<iframe class="lesson-preview" src="${esc(source)}" title="${esc(label)}" sandbox="allow-scripts" referrerpolicy="no-referrer" loading="lazy"></iframe>`;
  const narrationButton=actions.narrate?`<button class="small-button" id="narrate-result" ${narrationPending?'disabled':''}>${narrationPending?'正在请求配音…':'生成配音讲解'}</button>`:'';
  const exportButton=actions.exportVideo||exporting?`<button class="small-button" id="export-result" ${exporting||exportPending?'disabled':''}>${exporting?'正在导出视频…':exportPending?'正在请求导出…':'导出 MP4 视频'}</button>`:'';
  app.innerHTML=`<button class="back" id="back" aria-label="返回我的视频">返回我的视频</button><div class="result-grid ${interactive?'interactive-result':''}"><section class="player-column">${hasVideo?`<div class="player-frame"><video id="video" controls playsinline preload="metadata" ${result.cover?`poster="${esc(result.cover)}"`:''} src="${esc(result.video)}" aria-label="${esc(result.title)}视频讲解"></video></div>`:preview?`<div class="interactive-frame">${iframe(preview,`${result.title||'题目'}${interactive?'交互讲解':narrated?'配音讲解':'无配音讲解'}`)}</div>`:'<div class="panel"><p class="muted">暂时无法打开讲解预览，请稍后重新加载。</p></div>'}
    <div class="player-tools">${hasVideo?`<button class="small-button" id="rewind">↶ 后退 10 秒</button><label class="speed-label">倍速<select id="speed" aria-label="播放速度">${[.75,1,1.25,1.5,2].map(speed=>`<option value="${speed}" ${speed===1?'selected':''}>${speed}×</option>`).join('')}</select></label>`:''}<button class="small-button" id="theater" aria-pressed="false">放大观看</button>${hasVideo?`<a class="small-button" href="${esc(result.video)}" download="题解-${task.id}.mp4">下载视频</a>`:''}${result.download?`<a class="small-button" href="${esc(result.download)}" download="题解-${task.id}.html">${interactive?'下载交互网页':'下载讲解网页'}</a>`:''}${result.subtitles?`<a class="small-button" href="${esc(result.subtitles)}" download="题解-${task.id}.srt">下载字幕</a>`:''}${narrationButton}${exportButton}${sourceId?`<a class="small-button" id="source-result" href="#task/${esc(sourceId)}">查看原始讲解</a>`:''}</div>
    ${hasVideo?'<div id="video-error" class="error" role="alert" hidden>视频暂时无法加载。<button class="text-button" id="reload-video">重新加载视频</button></div>':''}
    ${exporting?'<p class="export-status" role="status"><span class="spinner"></span>正在将现有讲解导出为 MP4，可先阅读网页预览。</p>':!narrated?'<p class="muted tiny">当前为无配音讲解。需要时点击“生成配音讲解”，将复用已核对的原题与答案。</p>':!hasVideo?'<p class="muted tiny">当前为可播放的配音网页。导出 MP4 会复用已有配音，无需再次解题或配音。</p>':''}
    ${task.status==='failed'?`<p class="error" role="alert">${esc(errors[task.error]||'本次任务未完成，可继续查看已有讲解。')}</p>`:''}
    <div class="lesson-heading"><div><span class="eyebrow">${esc(getCapability(task.capability).title)} · ${esc(result.disclosure||'AI 辅助讲解')}</span><h1>${esc(result.title||task.title)}</h1></div><span class="badge neutral">${interactive?'交互讲解':hasVideo?formatTime(result.duration):narrated?'配音讲解':'无配音讲解'}</span></div>
    ${result.problem?`<details class="problem-details"><summary>查看完整题目</summary><p>${formatMath(result.problem)}</p></details>`:''}
    <div class="answer-card"><div><span class="mini-label">本题答案</span><div class="answer">${formatMath(result.answer,{answer:true})}</div></div><button class="small-button" id="copy-answer">复制答案</button></div><p class="muted tiny">AI 讲解仅供学习参考。${hasVideo?'点击解题步骤，可以跳到对应讲解。':interactive?'可在图形中操作视角或参数，对照步骤逐项检查。':'可对照右侧步骤，阅读网页中的动态板书。'}</p>
    ${hasVideo&&preview?`<details class="preview-panel"><summary>查看网页预览</summary>${iframe(preview,`${result.title||'题目'}网页预览`)}</details>`:''}</section>
    <aside class="panel chapters-panel"><div class="section-heading"><h2>解题步骤</h2><span class="mini-label">${steps.length} 步</span></div><div class="chapter-list">${steps.map((step,i)=>{const tag=hasVideo?'button':'div';return `<${tag} class="row step-result" ${hasVideo?`data-seek="${i}"`:''}><span class="number">${i+1}</span><span><span class="chapter-top"><strong>${formatMath(step.title)}</strong>${hasVideo?`<span class="chapter-time">${formatTime(starts[i])}</span>`:''}</span><span class="muted step-description">${formatMath(step.description)}</span></span></${tag}>`;}).join('')}</div><button class="btn" id="again">再拍一道题${icon('arrow')}</button></aside></div>`;
  document.querySelector('#back').onclick=()=>nav('videos');document.querySelector('#again').onclick=()=>nav('capture');
  document.querySelector('#theater').onclick=event=>{const wide=document.querySelector('.shell').classList.toggle('wide-player');event.currentTarget.textContent=wide?'恢复布局':'放大观看';event.currentTarget.setAttribute('aria-pressed',String(wide));};
  document.querySelector('#copy-answer').onclick=async event=>{const button=event.currentTarget;try{await navigator.clipboard.writeText(result.answer);button.textContent='已复制';}catch{button.textContent='请选中答案复制';}};
  const sourceControl=document.querySelector('#source-result');if(sourceControl)sourceControl.onclick=event=>{event.preventDefault();showTask(sourceId);};
  const narrationControl=document.querySelector('#narrate-result');if(narrationControl)narrationControl.onclick=()=>requestDerived(task,'narration');
  const exportControl=document.querySelector('#export-result');if(exportControl&&!exporting)exportControl.onclick=()=>requestDerived(task,'export');
  if(!hasVideo)return;
  const video=document.querySelector('#video');
  document.querySelector('#speed').onchange=event=>{video.playbackRate=Number(event.target.value);};
  document.querySelector('#rewind').onclick=()=>{video.currentTime=Math.max(0,video.currentTime-10);};
  video.onerror=()=>{document.querySelector('#video-error').hidden=false;};
  document.querySelector('#reload-video').onclick=()=>{document.querySelector('#video-error').hidden=true;video.load();};
  document.querySelectorAll('[data-seek]').forEach(button=>button.onclick=()=>{video.currentTime=starts[Number(button.dataset.seek)];video.play().catch(()=>{});});
  video.ontimeupdate=()=>{let active=0;starts.forEach((start,index)=>{if(video.currentTime>=start)active=index;});document.querySelectorAll('[data-seek]').forEach(button=>{const selected=Number(button.dataset.seek)===active;button.classList.toggle('playing',selected);if(selected)button.setAttribute('aria-current','step');else button.removeAttribute('aria-current');});};
}

async function requestDerived(task,action){
  const id=task.id,key=id+':'+action;if(derivedPending.has(key))return;
  const version=epoch,selector=action==='narration'?'#narrate-result':'#export-result',button=document.querySelector(selector);
  const label=action==='narration'?'生成配音讲解':'导出 MP4 视频';
  derivedPending.add(key);if(button){button.disabled=true;button.textContent=action==='narration'?'正在请求配音…':'正在请求导出…';}
  try{
    const next=await api('/api/tasks/'+id+'/'+action,{method:'POST',key});
    if(current==='task'&&taskId===id&&epoch===version)await showTask(next.id);
  }catch(error){
    if(current==='task'&&taskId===id&&epoch===version)showError(error);
  }finally{
    derivedPending.delete(key);
    if(current==='task'&&taskId===id){const control=document.querySelector(selector);if(control){control.disabled=false;control.textContent=label;}}
  }
}

document.addEventListener('visibilitychange',()=>{clearTimeout(timer);if(!document.hidden){if(current==='task')loadTask();if(current==='videos')refreshHistory();}});
window.addEventListener('online',()=>{checkHealth(true);if(current==='task')loadTask();if(current==='videos')refreshHistory();});
window.addEventListener('offline',updateHealthUI);
function openRoute(){const match=/^#task\/([a-f0-9-]{36})$/.exec(location.hash);if(match)return showTask(match[1]);nav(['capture','videos','profile'].includes(location.hash.slice(1))?location.hash.slice(1):'capture');}
window.addEventListener('hashchange',openRoute);openRoute();
