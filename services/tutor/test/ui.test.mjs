import test from 'node:test';
import assert from 'node:assert/strict';

const ui = await import('../../../apps/web/ui.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});

test('crop bounds stay inside the source image and reject an empty selection', () => {
  assert.equal(typeof ui.cropBounds, 'function', 'image cropping must have source bounds');
  assert.deepEqual(ui.cropBounds({x:-.1,y:.25,width:.6,height:1},1000,800),
    {x:0,y:200,width:500,height:600});
  assert.throws(() => ui.cropBounds({x:1,y:0,width:.2,height:.5},100,100));
  assert.throws(() => ui.cropBounds({x:NaN,y:0,width:1,height:1},100,100));
});

test('crop gestures in reverse directions select the same image area', () => {
  assert.equal(typeof ui.selectionFromPoints, 'function');
  assert.deepEqual(ui.selectionFromPoints({x:.8,y:.9},{x:.2,y:.1}),
    ui.selectionFromPoints({x:.2,y:.1},{x:.8,y:.9}));
  const r=ui.selectionFromPoints({x:-1,y:.1},{x:2,y:.9});
  assert.equal(r.x,0);assert.equal(r.width,1);
});

test('progress distinguishes queued work, checking, speech and video rendering', () => {
  assert.equal(typeof ui.taskPhase, 'function');
  assert.equal(ui.taskPhase({status:'queued',stage:'queued'}).key,'queued');
  assert.equal(ui.taskPhase({status:'running',stage:'checking'}).label,'正在复核解答');
  assert.equal(ui.taskPhase({status:'running',stage:'voicing'}).index,2);
  assert.equal(ui.taskPhase({status:'running',stage:'rendering'}).label,'正在制作视频');
});

test('lesson chapter seeking handles videos with and without an introduction', () => {
  assert.equal(typeof ui.chapterStarts, 'function');
  assert.deepEqual(ui.chapterStarts({steps:[{},{}],segments:[{at:0},{at:8},{at:22}]}),[8,22]);
  assert.deepEqual(ui.chapterStarts({steps:[{},{}],segments:[{at:0},{at:14}]}),[0,14]);
  assert.deepEqual(ui.chapterStarts({steps:[{},{}],segments:[]}),[0,0]);
});

test('upload errors reject unsupported or oversized files before reading them', () => {
  assert.equal(typeof ui.photoError,'function');
  assert.match(ui.photoError({type:'image/heic',size:100}),/PNG.*JPEG.*WebP/);
  assert.match(ui.photoError({type:'image/png',size:4194305}),/4MB/);
  assert.equal(ui.photoError({type:'image/png',size:4194304}),'');
});

test('video times remain readable for unloaded media and long lessons', () => {
  assert.equal(typeof ui.formatTime,'function');
  assert.equal(ui.formatTime(NaN),'0:00');
  assert.equal(ui.formatTime(-10),'0:00');
  assert.equal(ui.formatTime(125.9),'2:05');
});

test('silent video lessons finish without claiming speech or MP4 work', () => {
  const task={capability:'math-video',delivery:'lesson',status:'running',stage:'rendering'};
  assert.deepEqual(ui.taskSteps(task),['识别题目','解题与复核','制作讲解网页']);
  assert.equal(ui.taskPhase(task).index,2);assert.match(ui.taskPhase(task).label,/讲解网页/);
  assert.equal(ui.resultFormat({result:{format:'lesson',audioReady:false}}),'lesson');
});

test('narration of an interactive source describes reuse and stops before MP4', () => {
  const task={mode:'narration',capability:'solid-geometry',delivery:'video',status:'queued',stage:'queued'};
  assert.deepEqual(ui.taskSteps(task),['生成配音','制作配音网页']);
  assert.match(ui.taskPhase(task).label,/等待生成配音/);
  assert.match(ui.taskPhase({...task,status:'running',stage:'voicing'}).detail,/无需再次解题/);
  assert.equal(ui.taskPhase({...task,status:'running',stage:'rendering'}).index,1);
  assert.match(ui.taskPhase({...task,status:'running',stage:'rendering'}).detail,/MP4 可稍后/);
  assert.deepEqual(ui.taskSteps({mode:'export'}),['导出视频']);
});

test('result actions distinguish silent, narrated, running and legacy results', () => {
  for(const format of ['lesson','interactive']){
    const task={status:'completed',result:{format,audioReady:false,videoReady:false}};
    assert.equal(ui.hasNarration(task),false);assert.deepEqual(ui.resultActions(task),{narrate:true,exportVideo:false});
    assert.deepEqual(ui.resultActions({...task,status:'running'}),{narrate:false,exportVideo:false});
  }
  const narrated={status:'completed',result:{format:'video',audioReady:true,videoReady:false}};
  assert.deepEqual(ui.resultActions(narrated),{narrate:false,exportVideo:true});
  assert.deepEqual(ui.resultActions({...narrated,result:{format:'video',preview:'/old.html'}}),{narrate:false,exportVideo:true});
  assert.deepEqual(ui.resultActions({...narrated,result:{video:'/old.mp4'}}),{narrate:false,exportVideo:false});
  assert.deepEqual(ui.resultActions({...narrated,result:{format:'video',audioReady:false}}),{narrate:true,exportVideo:false});
});

test('budget copy shows cumulative admission reservations with historical amounts', () => {
  const budget={currency:'CNY',kind:'cumulative-reservation',limitCents:2000,reservedCents:2000,remainingCents:0};
  const copy=ui.projectBudgetText(budget);
  assert.match(copy,/累计预留 ¥20.00 \/ ¥20.00/);assert.match(copy,/可预留 ¥0.00/);
  assert.match(copy,/不代表供应商实际账单/);assert.doesNotMatch(copy,/账户余额|已花费|每日/);
  assert.equal(ui.projectBudgetText(null),'');assert.equal(ui.projectBudgetText({limitCents:NaN}),'');
});
