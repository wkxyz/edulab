import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const interactive = await import('../interactive.mjs').catch(e => {
  if (e.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw e;
});
const context = () => ({signal:new AbortController().signal, guard(){}});
async function build(capability, spec, options={}) {
  assert.equal(typeof interactive.buildInteractive, 'function', 'interactive builder is available');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'interactive-test-'));
  try {
    const result=await interactive.buildInteractive(capability,spec,dir,context(),options);
    return {result,html:fs.readFileSync(path.join(dir,'preview.html'),'utf8'),saved:JSON.parse(fs.readFileSync(path.join(dir,'lesson.json'),'utf8'))};
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}

test('custom cuboid parameters drive exact answer and visible coordinates',async()=>{
  const x=await build('solid-geometry',{body:'cuboid',dims:{lx:2,ly:3,lz:7},query:{type:'volume'}},{originalText:'长方体长2宽3高7，求体积'});
  assert.equal(x.result.answer,'42');assert.equal(x.result.format,'interactive');
  assert.equal(x.result.problem,'长方体长2宽3高7，求体积');
  assert.equal(x.saved.data.model.mathPoints.C1[2],7);
  assert.match(x.html,/42/);assert.ok(x.result.steps.length>=3);
});

test('solid midpoint and arbitrary target plane share the exact kernel solution',async()=>{
  const x=await build('solid-geometry',{body:'cube',dims:{edge:2},givens:[{name:'E',kind:'midpoint',of:['A1','C1']}],query:{type:'point_plane_distance',point:'E',plane:['A','B','D']}});
  assert.equal(x.result.answer,'2');assert.deepEqual(x.saved.data.model.mathPoints.E,[1,1,2]);
});

test('solid line angles and oriented dihedral are computed from specified vertices',async()=>{
  const x=await build('solid-geometry',{body:'cube',dims:{edge:3},query:{type:'line_line_angle',line1:['A','B'],line2:['A','C']}});
  assert.equal(x.result.answer,'\\frac{\\sqrt{2}}{2}');
  const y=await build('solid-geometry',{body:'regular_tetrahedron',dims:{edge:2},query:{type:'dihedral',edge:['A','B'],faces:['C','D']}});
  assert.equal(y.result.answer,'\\frac{1}{3}');
});

test('custom ellipse chord bounds include horizontal and vertical endpoint chords',async()=>{
  const x=await build('analytic-geometry',{conic:{kind:'ellipse',a:3,b:2},query:{type:'chord_length_range',through:[0,0]}});
  assert.equal(x.result.answer,'[4,\\ 6]');
  assert.equal(x.saved.data.board.rangeBar.min,4);assert.equal(x.saved.data.board.rangeBar.max,6);
});

test('translated ellipse and off-axis interior point retain a genuine custom problem',async()=>{
  const x=await build('analytic-geometry',{conic:{kind:'ellipse',a:3,b:2,center:[2,-1]},query:{type:'dot_product_range',through:[2,0],vertex:[2,0]}});
  assert.equal(x.result.answer,'[- \\frac{27}{4},\\ -3]');
  assert.deepEqual(x.saved.data.board.conics[0].center,[2,-1]);
});

test('parabola focus chords have vertex-based dot constant for custom p',async()=>{
  const x=await build('analytic-geometry',{conic:{kind:'parabola',p:4},query:{type:'parabola_dot_constant'}});
  assert.equal(x.result.answer,'-12');assert.deepEqual(x.saved.data.board.points.M,[0,0]);
});

test('central ellipse chord triangle areas use exact closed bounds',async()=>{
  const x=await build('analytic-geometry',{conic:{kind:'ellipse',a:3,b:2,center:[1,2]},query:{type:'triangle_area_range',through:[1,2],vertex:[2,3]}});
  assert.equal(x.result.answer,'[0,\\ \\sqrt{13}]');
  await assert.rejects(build('analytic-geometry',{conic:{kind:'ellipse',a:3,b:2},query:{type:'triangle_area_range',through:[1,0],vertex:[2,3]}}),/UNSUPPORTED_PROBLEM/);
});

test('hyperbola focal ratio yields a moving point with matching focal distances',async()=>{
  const x=await build('analytic-geometry',{conic:{kind:'hyperbola'},query:{type:'eccentricity_range',ratio:2}});
  assert.equal(x.result.answer,'(1,\\ 3]');
  const e=2;const expression=x.saved.data.board.points.P.xy[0];
  // Evaluate this renderer expression through the generated arithmetic interpreter.
  const fn=x.html.slice(x.html.indexOf('    function evalExpr(expr, env){'),x.html.indexOf('    const resolveVal='));
  const evaluate=Function('MATHENV',`${fn}; return evalExpr;`)({sqrt:Math.sqrt});
  const px=evaluate(expression,{e});
  assert.equal(px,1.5);
  const py=evaluate(x.saved.data.board.points.P.xy[1],{e});
  assert.ok(Math.abs(Math.hypot(px+e,py)/Math.hypot(px-e,py)-2)<1e-10);
  assert.ok(Number.isNaN(evaluate('globalThis.pwned=1',{e})));
});

test('chemistry balances new allowed-species reactions and pairs every atom',async()=>{
  const x=await build('chem-reaction',{reactants:[{species:'N2'},{species:'H2'}],products:[{species:'NH3'}],conditions:{text:'催化'}});
  assert.equal(x.saved.data.atoms.length,8);assert.deepEqual(x.saved.data.elementCounts,{N:2,H:6});
  assert.match(x.result.answer,/3.*H/);assert.match(x.result.answer,/2.*NH/);
  assert.equal(new Set(x.saved.data.atoms.map(a=>a.id)).size,8);
});

test('explicit sample mode uses actual upstream builders',async()=>{
  const x=await build('solid-geometry',null,{sampleId:'default'});
  assert.equal(x.result.answer,'\\frac{2 \\sqrt{22}}{11}');
  const y=await build('chem-reaction',null,{sampleId:'default'});
  assert.equal(y.saved.data.elementCounts.C,1);assert.equal(y.saved.data.elementCounts.O,4);
});

test('unsupported or degenerate inputs fail instead of substituting examples',async()=>{
  for(const [cap,spec] of [
    ['solid-geometry',{body:'cylinder',dims:{r:2},query:{type:'volume'}}],
    ['solid-geometry',{body:'cube',dims:{edge:1},query:{type:'point_plane_distance',point:'A1',plane:['A','A','B']}}],
    ['analytic-geometry',{conic:{kind:'hyperbola',a:2,b:1},query:{type:'chord_length_range',through:[0,0]}}],
    ['analytic-geometry',{conic:{kind:'ellipse',a:2,b:1},query:{type:'dot_product_range',through:[3,0],vertex:[0,0]}}],
    ['analytic-geometry',{conic:{kind:'hyperbola',a:2,b:1},query:{type:'eccentricity_range',ratio:2}}],
    ['chem-reaction',{reactants:[{species:'Na'}],products:[{species:'H2O'}]}],
  ]) await assert.rejects(build(cap,spec),/UNSUPPORTED_PROBLEM|INVALID_INTERACTIVE_SPEC/);
});

test('JSON code, expression, oversized and user markup inputs cannot become scripts',async()=>{
  await assert.rejects(build('solid-geometry',{body:'cube',dims:{edge:'__import__("os")'},query:{type:'volume'}}),/INVALID_INTERACTIVE_SPEC/);
  await assert.rejects(build('chem-reaction',{reactants:[{species:'H2',count:100000}],products:[{species:'H2O'}]}),/INVALID_INTERACTIVE_SPEC/);
  await assert.rejects(build('analytic-geometry',{conic:{kind:'ellipse',a:2,b:1},query:{type:'chord_length_range',through:[0,0]},board:{expr:'fetch("https://evil.test")'}}),/INVALID_INTERACTIVE_SPEC/);
  const title='</script><script>globalThis.pwned=1</script><img src=x onerror=alert(1)>';
  const x=await build('solid-geometry',{title,body:'cube',dims:{edge:2},query:{type:'volume'}});
  const dataText=/<script id="lesson-data" type="application\/json">([\s\S]*?)<\/script>/.exec(x.html)[1];
  assert.equal(JSON.parse(dataText).lesson.title,title);
  assert.doesNotMatch(x.html,/<script>globalThis\.pwned|<img src=x/);
});

test('cancellation prevents a subprocess and publishing its result',async()=>{
  assert.equal(typeof interactive.buildInteractive,'function');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'interactive-cancel-'));
  try {await assert.rejects(interactive.buildInteractive('solid-geometry',null,dir,{signal:AbortSignal.abort(),guard(){throw new Error('CANCELLED');}},{sampleId:'default'}),/CANCELLED/);assert.equal(fs.existsSync(path.join(dir,'preview.html')),false);}
  finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('cancellation after computation removes unpublished HTML and metadata',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'interactive-cancel-after-'));let guards=0;
  try {await assert.rejects(interactive.buildInteractive('solid-geometry',null,dir,{signal:new AbortController().signal,guard(){if(++guards===3)throw new Error('CANCELLED');}},{sampleId:'default'}),/CANCELLED/);assert.equal(fs.existsSync(path.join(dir,'preview.html')),false);assert.equal(fs.existsSync(path.join(dir,'lesson.json')),false);}
  finally {fs.rmSync(dir,{recursive:true,force:true});}
});
