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
