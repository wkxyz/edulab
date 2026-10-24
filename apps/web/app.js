import {createClient} from './api-client.mjs';
import {chapterStarts, formatTime, photoError, taskPhase} from './ui.mjs';
import {editPhoto} from './photo-editor.mjs';

const app = document.querySelector('#app');
let current='capture', taskId='', timer, clock, photo, busy=false, epoch=0, selectionId=0;
let createKey=crypto.randomUUID(), health, healthPending, healthChecked=0, healthError=false;
let tasks=[], filter='all', search='', taskViewKey='';
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = name => `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true">${{
  camera:'<path d="M3 7h5l2-3h4l2 3h5v13H3z"/><circle cx="12" cy="13" r="4"/>',
  play:'<path d="m9 5 11 7-11 7z"/>', crop:'<path d="M6 3v15h15M3 6h15v15"/>',
  check:'<path d="m5 12 4 4L19 6"/>', arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
  book:'<path d="M12 5v15M3 4c4-1 7 0 9 2 2-2 5-3 9-2v15c-4-1-7 0-9 2-2-2-5-3-9-2z"/>',
}[name]||''}</svg>`;
const errors={NOT_CONFIGURED:'真实解题服务尚未开通，可先体验示例讲解。',STOPPED:'服务已暂停，请稍后再试。',OWNER_LIMIT:'今天的体验次数已用完。',PROJECT_LIMIT:'今天的生成额度已用完。',TOTAL_LIMIT:'体验服务容量已满。',QUEUE_FULL:'当前排队较多，请稍后再试。',BUDGET_EXHAUSTED:'今天的服务额度已用完。',INVALID_IMAGE:'图片格式不正确，请重新选择。',REVIEW_FAILED:'解答未通过复核，请重新拍摄完整题目。',INVALID_LESSON:'暂时无法可靠讲解这道题，请重新拍摄。',CANCELLED:'任务已取消。',TIMEOUT:'本次生成超时，请稍后重试。',EXPIRED:'任务已过期。',INTERRUPTED:'服务重启，本次任务已停止，可重新提交。'};
const api=createClient({message:code=>errors[code]||'暂时无法完成，请稍后重试。'});

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
  if(!navigator.onLine)return {title:'当前网络已断开',detail:'请连接网络后继续，已选图片会保留在当前页面。',kind:'offline'};
  if(healthError)return {title:'暂时无法连接讲解服务',detail:'请检查网络后重试。已选图片会保留在当前页面。',kind:'offline'};
  if(!health)return {title:'正在连接讲解服务',detail:'可先选好一道清晰、完整的题目。',kind:'connecting'};
  if(health.stopped)return {title:'服务暂时暂停',detail:'请稍后再试，视频记录会保留。',kind:'offline'};
  if(!health.liveEnabled)return {title:'示例体验中',detail:'上传图片可预览、裁剪和旋转。真实解题暂未开放，可以先体验示例视频。',kind:'sample'};
  return {title:'讲解服务已开启',detail:'支持 PNG、JPEG、WebP，每次一道题，图片不超过 4MB。',kind:'live'};
}
function updateHealthUI(){const info=healthText(),box=document.querySelector('[data-service-status]');if(box){box.dataset.kind=info.kind;box.innerHTML=`<span class="status-dot"></span><div><strong>${info.title}</strong><p>${info.detail}</p></div>`;}}
async function checkHealth(force=false){
  if(!force&&health&&Date.now()-healthChecked<30000)return health;
  if(!healthPending)healthPending=api('/api/health',{auth:false}).then(value=>{health=value;healthError=false;healthChecked=Date.now();return value;}).catch(()=>{healthError=true;return null;}).finally(()=>{healthPending=null;updateHealthUI();});
  return healthPending;
}
function capture(){
  const info=healthText();
  app.innerHTML=`<div class="page-intro"><span class="eyebrow">让思路看得见</span><h1>拍一道题，听懂每一步</h1><p class="sub">把题目变成有板书、有配音的分步讲解。</p></div>
    <div class="capture-grid"><section class="panel upload-panel" aria-label="上传题目"><div class="section-heading"><h2>上传一道题</h2><span class="mini-label">手机 · 电脑</span></div>
    <div class="service-status" data-service-status data-kind="${info.kind}"><span class="status-dot"></span><div><strong>${info.title}</strong><p>${info.detail}</p></div></div>
    <input id="file" type="file" accept="image/png,image/jpeg,image/webp" hidden>
    ${photo?`<div class="photo-card"><img class="photo-preview" src="${esc(photo.image)}" alt="已选题目" data-cropped="${!!photo.cropped}"><div class="photo-caption"><span>${esc(photo.name)}</span>${photo.cropped?'<span class="badge success">已调整</span>':''}</div></div><div class="photo-actions"><button class="small-button" id="edit-photo">${icon('crop')}裁剪 / 旋转</button><button class="small-button" id="choose">重新选择</button>${photo.cropped?'<button class="text-button" id="restore-photo">还原原图</button>':''}</div><p class="muted upload-help">确认整道题清楚、完整，包含题干、条件和图形。</p><button class="btn" id="submit">生成视频讲解${icon('arrow')}</button>`:
    `<button class="upload" id="choose">${icon('camera')}<strong>拍照 / 选择图片</strong><span>或将图片拖到这里</span><small>支持粘贴截图 · PNG / JPEG / WebP · 最大 4MB</small></button>`}
    <div id="error" role="alert" hidden></div><p class="privacy-note">${icon('check')}图片确认后才会提交，裁剪在你的浏览器内完成。</p></section>
    <aside class="capture-aside"><section class="panel sample-panel"><span class="eyebrow">先看一个完整示例</span><h2>一道方程，三步讲明白</h2><p class="muted">从变形到验算，跟着板书看懂每一步。</p><button class="sample" id="sample-row"><span class="mini-label">一元一次方程 · 固定示例</span><span class="formula">2x + 3 = 11</span><span class="sample-answer">从哪里开始？为什么这样算？</span></button><button class="btn" id="sample">${icon('play')}体验示例讲解</button><p class="muted tiny">固定题目 · 离线配音 · 不消耗真实解题次数</p></section><section class="panel tips-panel"><h2>怎样拍得更清楚</h2><ol><li>一次只保留一道题</li><li>题干、选项和图形都拍完整</li><li>尽量正对纸面，避开阴影</li></ol></section></aside></div><p class="footer">AI 讲解仅供学习参考，请结合教材核对。</p>`;
  document.querySelector('#choose').onclick=()=>document.querySelector('#file').click();
  document.querySelector('#file').onchange=event=>acceptFile(event.target.files[0]);
  if(photo){
    document.querySelector('#submit').onclick=()=>start({image:photo.image,style:'chalk'});
    document.querySelector('#edit-photo').onclick=async()=>{const version=epoch,selected=photo;try{const result=await editPhoto(photo.image);if(result&&current==='capture'&&epoch===version&&photo===selected){photo={...photo,...result,cropped:true};createKey=crypto.randomUUID();capture();}}catch(error){if(current==='capture')showError(error);}};
    const restore=document.querySelector('#restore-photo');if(restore)restore.onclick=()=>{photo={...photo,image:photo.original,cropped:false};createKey=crypto.randomUUID();capture();};
  }
  document.querySelector('#sample').onclick=document.querySelector('#sample-row').onclick=()=>start({sampleId:'equation',style:'chalk'});
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
  if(!data.sampleId&&health&&!health.liveEnabled)return showError(new Error(errors[health.stopped?'STOPPED':'NOT_CONFIGURED']));
  busy=true;const version=epoch,active=document.querySelector(data.sampleId?'#sample':'#submit'),label=active?.innerHTML;
  app.querySelectorAll('button').forEach(button=>button.disabled=true);if(active)active.textContent='正在提交…';
  try{const task=await api('/api/tasks',{method:'POST',data,key:createKey});createKey=crypto.randomUUID();if(epoch===version)await showTask(task.id);}
  catch(error){if(epoch===version)showError(error);}
  finally{busy=false;if(active?.isConnected)active.innerHTML=label;app.querySelectorAll('button').forEach(button=>button.disabled=false);}
}

function history(){
  app.innerHTML=`<div class="page-intro compact"><span class="eyebrow">每次思考，都有迹可循</span><h1>我的视频</h1><p class="sub">在这台设备上提交的讲解，随时回来复习。</p></div><section class="panel history-panel"><div class="history-toolbar"><div class="filters" aria-label="视频状态筛选"><button data-filter="all">全部</button><button data-filter="completed">已完成</button><button data-filter="active">生成中</button></div><label class="search-field"><span class="sr-only">搜索视频</span><input id="search" type="search" placeholder="搜索题目" value="${esc(search)}"></label></div><div id="list" role="status"><div class="loading-panel"><span class="spinner"></span>正在加载视频…</div></div><p class="history-note tiny muted">记录保存在当前浏览器会话。清除浏览器数据后可能无法找回。</p></section>`;
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
  const found=tasks.filter(task=>(filter==='all'||(filter==='active'?['running','queued'].includes(task.status):task.status===filter))&&task.title.toLowerCase().includes(search.trim().toLowerCase()));
  const labels={queued:'排队中',running:'生成中',completed:'已完成',failed:'生成失败',cancelled:'已取消'};
  list.innerHTML=found.length?`<div class="video-grid">${found.map(task=>`<button class="video-card" data-task="${esc(task.id)}"><div class="video-thumb">${task.result?.cover?`<img src="${esc(task.result.cover)}" alt="" loading="lazy">`:icon('book')}${task.result?.duration?`<span class="duration-label">${formatTime(task.result.duration)}</span>`:''}</div><div class="video-card-body"><div class="card-badges"><span class="badge ${task.status==='completed'?'success':task.status==='failed'?'danger':'neutral'}">${labels[task.status]||'处理中'}</span>${task.mode==='sample'?'<span class="mini-label">固定示例</span>':''}</div><strong>${esc(task.title)}</strong><span class="muted tiny">${new Date(task.created).toLocaleString('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</span></div></button>`).join('')}</div>`:
    `<div class="empty">${icon('book')}<h2>${tasks.length?'没有找到匹配的视频':'还没有视频'}</h2><p>${tasks.length?'换个关键词或筛选条件试试。':'从一个完整示例开始，看看讲解是什么样的。'}</p>${tasks.length?'<button class="small-button" id="clear-filter">清除筛选</button>':'<button class="btn" id="empty-capture">去拍一道题</button>'}</div>`;
  document.querySelectorAll('[data-task]').forEach(button=>button.onclick=()=>showTask(button.dataset.task));
  const empty=document.querySelector('#empty-capture');if(empty)empty.onclick=()=>nav('capture');
  const clear=document.querySelector('#clear-filter');if(clear)clear.onclick=()=>{filter='all';search='';document.querySelector('#search').value='';renderHistory();};
}
async function profile(){
  app.innerHTML=`<div class="page-intro compact"><span class="eyebrow">安心使用，随时回看</span><h1>我的</h1></div><div class="profile-grid"><section class="panel"><h2>设备体验账号</h2><p class="muted">使用当前浏览器查看题目和视频记录。</p><div class="service-status" data-service-status></div><button class="small-button" id="refresh-health">刷新服务状态</button></section><section class="panel"><h2>关于题解</h2><p class="muted">上传一道题，生成有板书、有配音的分步视频讲解。</p><div class="note">AI 输出可能有误，请结合教材核对。讲解用于辅助理解。</div><p class="muted tiny">跨设备账号登录和付费暂未开放。清除浏览器数据后可能无法找回历史记录。</p></section></div>`;
  updateHealthUI();document.querySelector('#refresh-health').onclick=()=>checkHealth(true);await checkHealth();
}

async function loadTask(){
  clearTimeout(timer);const id=taskId,version=epoch;
  try{const task=await api('/api/tasks/'+id);if(current!=='task'||taskId!==id||epoch!==version)return;
    const key=`${id}:${task.status}:${task.stage}:${task.error||''}`;
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
  const terminal=['failed','cancelled'].includes(task.status),phase=taskPhase(task);
  app.innerHTML=`<button class="back" id="back" aria-label="返回我的视频">返回我的视频</button><div class="task-grid"><section class="panel progress-panel"><div class="section-heading"><span class="eyebrow">${task.mode==='sample'?'固定示例讲解':'你的题目'}</span><span class="badge neutral" id="elapsed"></span></div><h1>${esc(task.title)}</h1>${terminal?`<div class="task-notice"><h2>${task.status==='cancelled'?'本次生成已取消':'这次没有完成'}</h2><p class="error" role="alert">${esc(errors[task.error]||'生成失败，请重新提交。')}</p><p class="muted">可以检查题目是否完整，再重新试一次。</p><button class="btn" id="again">重新拍题</button></div>`:
    `<div class="current-phase" role="status"><span class="spinner"></span><div><h2>${phase.label}</h2><p class="muted">${phase.detail}</p></div></div><ol class="steps" aria-label="讲解生成进度">${['识别题目','解题与复核','生成配音','制作视频'].map((label,index)=>`<li class="step ${index<phase.index?'done':index===phase.index?'active':''}"><span class="dot">${index<phase.index?icon('check'):index+1}</span><div><strong>${label}</strong><small>${index<phase.index?'已完成':index===phase.index?(phase.key==='queued'?'等待开始':'正在进行'):'等待中'}</small></div></li>`).join('')}</ol><div class="progress-actions"><button class="btn" id="history">查看我的视频</button><button class="text-button" id="cancel">取消本次生成</button></div>`}</section><aside class="panel waiting-panel"><span class="eyebrow">不必一直等在这里</span><h2>稍后回来，继续看懂这道题</h2><p class="muted">可以离开页面，在“视频”中查看进度。关闭浏览器不会取消服务器上的任务。</p><div class="note">${task.mode==='sample'?'这是固定方程示例，配音和视频均由服务器生成。':'生成时间取决于题目和讲解长度，请耐心等待。'}</div></aside></div>`;
  document.querySelector('#back').onclick=()=>nav('videos');
  if(terminal)document.querySelector('#again').onclick=()=>nav('capture');
  else{
    const elapsed=()=>{const node=document.querySelector('#elapsed');if(node)node.textContent='已等待 '+formatTime((Date.now()-task.created)/1000);};elapsed();clock=setInterval(elapsed,1000);
    document.querySelector('#history').onclick=()=>nav('videos');
    document.querySelector('#cancel').onclick=async event=>{event.currentTarget.disabled=true;event.currentTarget.textContent='正在取消…';try{await api('/api/tasks/'+taskId+'/cancel',{method:'POST'});await loadTask();}catch(error){showError(error);const button=document.querySelector('#cancel');if(button){button.disabled=false;button.textContent='取消本次生成';}}};
  }
}
function renderResult(task){
  const result=task.result,starts=chapterStarts(result);
  app.innerHTML=`<button class="back" id="back" aria-label="返回我的视频">返回我的视频</button><div class="result-grid"><section class="player-column"><div class="player-frame"><video id="video" controls playsinline preload="metadata" poster="${esc(result.cover)}" src="${esc(result.video)}" aria-label="${esc(result.title)}视频讲解"></video></div><div class="player-tools"><button class="small-button" id="rewind">↶ 后退 10 秒</button><label class="speed-label">倍速<select id="speed" aria-label="播放速度">${[.75,1,1.25,1.5,2].map(speed=>`<option value="${speed}" ${speed===1?'selected':''}>${speed}×</option>`).join('')}</select></label><button class="small-button" id="theater">放大观看</button><a class="small-button" href="${esc(result.video)}" download="题解-${task.id}.mp4">下载视频</a></div><div id="video-error" class="error" role="alert" hidden>视频暂时无法加载。<button class="text-button" id="reload-video">重新加载视频</button></div><div class="lesson-heading"><div><span class="eyebrow">${esc(result.disclosure)}</span><h1>${esc(result.title)}</h1></div><span class="badge neutral">${formatTime(result.duration)}</span></div><div class="answer-card"><div><span class="mini-label">本题答案</span><div class="answer">${esc(result.answer)}</div></div><button class="small-button" id="copy-answer">复制答案</button></div><p class="muted tiny">AI 讲解仅供学习参考。点击解题步骤，可以跳到对应讲解。</p></section><aside class="panel chapters-panel"><div class="section-heading"><h2>解题步骤</h2><span class="mini-label">${result.steps.length} 步</span></div><div class="chapter-list">${result.steps.map((step,i)=>`<button class="row step-result" data-seek="${i}"><span class="number">${i+1}</span><span><span class="chapter-top"><strong>${esc(step.title)}</strong><span class="chapter-time">${formatTime(starts[i])}</span></span><span class="muted">${esc(step.description)}</span></span></button>`).join('')}</div><button class="btn" id="again">再拍一道题${icon('arrow')}</button></aside></div>`;
  const video=document.querySelector('video');
  document.querySelector('#back').onclick=()=>nav('videos');document.querySelector('#again').onclick=()=>nav('capture');
  document.querySelector('#speed').onchange=event=>{video.playbackRate=Number(event.target.value);};
  document.querySelector('#rewind').onclick=()=>{video.currentTime=Math.max(0,video.currentTime-10);};
  document.querySelector('#theater').onclick=event=>{const wide=document.querySelector('.shell').classList.toggle('wide-player');event.currentTarget.textContent=wide?'恢复布局':'放大观看';event.currentTarget.setAttribute('aria-pressed',String(wide));};
  document.querySelector('#copy-answer').onclick=async event=>{const button=event.currentTarget;try{await navigator.clipboard.writeText(result.answer);button.textContent='已复制';}catch{button.textContent='请选中答案复制';}};
  video.onerror=()=>{document.querySelector('#video-error').hidden=false;};
  document.querySelector('#reload-video').onclick=()=>{document.querySelector('#video-error').hidden=true;video.load();};
  document.querySelectorAll('[data-seek]').forEach(button=>button.onclick=()=>{video.currentTime=starts[Number(button.dataset.seek)];video.play().catch(()=>{});});
  video.ontimeupdate=()=>{let active=0;starts.forEach((start,index)=>{if(video.currentTime>=start)active=index;});document.querySelectorAll('[data-seek]').forEach(button=>{const selected=Number(button.dataset.seek)===active;button.classList.toggle('playing',selected);if(selected)button.setAttribute('aria-current','step');else button.removeAttribute('aria-current');});};
}
document.addEventListener('visibilitychange',()=>{clearTimeout(timer);if(!document.hidden){if(current==='task')loadTask();if(current==='videos')refreshHistory();}});
window.addEventListener('online',()=>{checkHealth(true);if(current==='task')loadTask();if(current==='videos')refreshHistory();});
window.addEventListener('offline',updateHealthUI);
function openRoute(){const match=/^#task\/([a-f0-9-]{36})$/.exec(location.hash);if(match)return showTask(match[1]);nav(['capture','videos','profile'].includes(location.hash.slice(1))?location.hash.slice(1):'capture');}
window.addEventListener('hashchange',openRoute);openRoute();
