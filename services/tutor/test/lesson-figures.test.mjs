import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateFigure, validateFigureAction, createFigureActionContext, validateGraphExpression } from '../lesson-figures.mjs';
import { compile, expandIntro } from '../../../skills/edu-math-video/lesson/scripts/compile.mjs';
import '../../../skills/edu-math-video/lesson/engine/core.js';
import '../../../skills/edu-math-video/lesson/engine/figure.js';

const triangle = () => ({ type: 'plane2d', points: { A: [0, 2], B: [0, 0], C: [4, 0] }, edges: [['A', 'B'], ['B', 'C'], ['C', 'A']] });
const graph = () => ({ type: 'graph', points: { P: [1, 2] }, view: { xmin: -2, xmax: 4, ymin: -1, ymax: 7 } });
const invalid = fn => assert.throws(fn, error => error.code === 'UNSUPPORTED_ANIMATION' && error.status === 400);
const theme = {
  roles: Object.fromEntries(['edge', 'given', 'aux', 'key', 'axis', 'face', 'tri', 'plane', 'plane2'].map(role => [role, { c: '#123456', f: '#abcdef', o: 0.2, w: 2 }])),
  hid: { dash: '8 8' }, hidAcc: {}, labelSize: 24, labelColor: '#123456', dot: '#123456',
};

test('real upstream lessons normalize, compile and render all three native figure types', async () => {
  for (const example of ['triangle', 'prism-de', 'parabola']) {
    const lesson = JSON.parse(await readFile(new URL(`../../../skills/edu-math-video/lesson/examples/${example}/lesson.json`, import.meta.url), 'utf8'));
    lesson.figure = validateFigure(lesson.figure);
    const actions = lesson.scenes.flatMap(scene => scene.beats.flatMap(beat => beat.do || []));
    const context = createFigureActionContext(lesson.figure, actions);
    for (const scene of lesson.scenes) for (const beat of scene.beats) {
      beat.do = (beat.do || []).map(action => validateFigureAction(action, lesson.figure, context) || action);
    }
    const beats = expandIntro(lesson).scenes.flatMap(scene => scene.beats);
    const timeline = compile(lesson, beats.map(() => ({ duration: 3, file: 'fixture.mp3' })));
    const operations = timeline.ops.filter(op => op.kind === 'fig' || op.kind === 'cam');
    const engine = globalThis.SV.figure.create(timeline.figure, operations);
    engine.fit(500, 500, timeline.duration);
    const intro = engine.intro(0);
    const rendered = engine.render(timeline.duration, [...intro, ...operations], theme);
    assert.match(rendered.svg, /<(?:line|path|polygon)/, example);
    assert.doesNotMatch(rendered.svg, /NaN|Infinity|undefined/, example);
    if (example === 'parabola') assert.deepEqual(engine.P.Q, [1, -1, 0], 'native forward point reference remains supported');
    if (example === 'prism-de') {
      assert.equal(engine.edges.length, 9);
      assert.deepEqual(engine.P.F, [1, 0, 0]);
      assert.ok(engine.camOps.length > 0);
    }
  }
});

test('normalization clones geometry, resolves declared extras and leaves source unmodified', () => {
  const input = { ...triangle(), extra: [{ name: 'M', mid: ['A', 'B'] }, { name: 'N', mid: ['M', 'C'] }], given: [['M', 'N']], marks: [{ op: 'par', a: 'M', b: 'N', n: 2 }] };
  const before = structuredClone(input), normalized = validateFigure(input);
  assert.deepEqual(input, before);
  assert.notEqual(normalized.points.A, input.points.A);
  assert.notEqual(normalized.extra[0].mid, input.extra[0].mid);
  assert.deepEqual(validateFigureAction({ fig: 'seg', a: 'M', b: 'N', role: 'aux' }, normalized), { fig: 'seg', a: 'M', b: 'N', role: 'aux' });
  assert.equal(validateFigure(undefined), undefined);
  assert.equal(validateFigureAction({ write: '计算' }, undefined), null);
  assert.ok(createFigureActionContext(undefined, [{ write: '计算' }, { emph: 'last' }, { tip: '提示' }]));
  invalid(() => createFigureActionContext(undefined, [{ fig: 'dot', p: 'A' }]));
  assert.deepEqual(validateFigure({ type: 'graph' }).view, { xmin: -5, xmax: 5, ymin: -5, ymax: 5 });
});

test('arithmetic grammar preserves math precedence through the actual native Function compiler', () => {
  const values = [
    ['x^2-2*x+3', 1, 2], ['-x^2', 3, -9], ['(-x)^2', 3, 9], ['2^3^2', 0, 512],
    ['x^-2', 2, 0.25], ['sin(PI/2)+cos(0)+tan(0)', 2, 2], ['sqrt(abs(x))+ln(exp(1))+log(1)', -9, 4],
    ['1e-3*x+.5', 500, 1], ['x+(+2)', 1, 3],
  ];
  for (const [source, x, expected] of values) {
    const normalized = validateGraphExpression(source);
    assert.equal(validateGraphExpression(normalized), normalized, `idempotent expression: ${source}`);
    assert.ok(Math.abs(globalThis.SV.figure.compileFn(normalized)(x) - expected) < 1e-10, source);
  }
});

test('expression grammar denies JavaScript escape routes, unknown identifiers, and parsing amplification', () => {
  for (const source of [
    'globalThis.process.exit()', 'process', 'Math.sin(x)', 'x.constructor', 'constructor(x)', 'sin.constructor(x)',
    'x[0]', 'x;alert(1)', '(x,1)', 'sin(x,1)', 'x=1', 'x=>x', 'x?1:2', 'x||1', 'x&1',
    '`x`', '"x"', "'x'", 'x/*comment*/+1', 'x//comment', 'eval(x)', 'require(x)',
    's\\u0069n(x)', '%73in(x)', '&#120;', 'sin', 'PI(x)', 'E', 'min(x)', 'pow(x)', '2x', 'x**2',
    '1e999', '9'.repeat(500), '1e-99', '2^999', '2^2^2^2^2', 'exp(1000)', '1/0',
    '('.repeat(30) + 'x' + ')'.repeat(30), '-'.repeat(100) + 'x', 'sin('.repeat(26) + 'x' + ')'.repeat(26),
    'x+'.repeat(100) + 'x', 'x'.repeat(513), '', null, { toString: () => 'x' },
  ]) invalid(() => validateGraphExpression(source));
});

test('geometry bounds reject invalid references, non-finite values and excessive shape sizes', () => {
  const cases = [
    null, {}, { type: 'html' }, { ...triangle(), points: { A: [0, Infinity] } },
    { ...triangle(), points: { A: [NaN, 0] } }, { ...triangle(), points: { A: [10001, 0] } },
    { ...triangle(), points: { A: [0, 0, 1] } }, { ...triangle(), edges: [['A', 'Unknown']] },
    { ...triangle(), edges: [['A', 'A']] }, { ...triangle(), edges: Array.from({ length: 97 }, () => ['A', 'B']) },
    { ...triangle(), extra: [{ name: 'A', pos: [0, 0] }] }, { ...triangle(), extra: [{ name: 'M', mid: ['N', 'B'] }] },
    { ...triangle(), extra: [{ name: 'M', mid: ['A', 'B'], pos: [1, 2] }] },
    { ...triangle(), extra: [{ name: 'M', mid: ['A', 'A'] }] },
    { ...triangle(), points: Object.fromEntries(Array.from({ length: 49 }, (_, i) => [`P${i}`, [i, 0]])) },
    { ...triangle(), marks: [{ op: 'rt', v: 'B', a: 'A', b: 'Unknown' }] },
    { ...triangle(), marks: [{ op: 'html', html: '<script/>' }] },
    { ...triangle(), marks: [{ op: 'rt', fig: 'point', name: 'M', pos: [1, 2] }] },
    { ...triangle(), zoom: 100 }, { ...triangle(), labels: 'false' },
    { ...graph(), view: { xmin: 2, xmax: -2, ymin: -1, ymax: 7 } },
    { ...graph(), view: { xmin: 1, xmax: 1.00000001, ymin: -1, ymax: 7 } },
    { ...graph(), tick: 0 }, { ...graph(), tick: -1 }, { ...graph(), tick: 0.0001 },
    { ...graph(), points: null },
    { ...graph(), curves: [{ f: 'x', fill: 'url(https://evil.test)' }] },
    { ...graph(), curves: Array.from({ length: 9 }, () => ({ f: 'x' })) },
    { ...triangle(), curves: [{ f: 'x' }] }, { ...graph(), camera: { home: { az: 0, el: 20 } } },
  ];
  for (const value of cases) invalid(() => validateFigure(value));
});

test('3D face and camera data is bounded and references declared geometry', async () => {
  const lesson = JSON.parse(await readFile(new URL('../../../skills/edu-math-video/lesson/examples/prism-de/lesson.json', import.meta.url), 'utf8'));
  const raw = lesson.figure, solid = validateFigure(raw);
  for (const value of [
    { ...raw, faces: undefined }, { ...raw, faces: Array.from({ length: 33 }, () => ['A', 'B', 'C']) },
    { ...raw, faces: [Array.from({ length: 13 }, () => 'A'), ...raw.faces] },
    { ...raw, faces: [['A', 'B', 'Missing'], ...raw.faces] }, { ...raw, faces: [['A', 'B', 'A'], ...raw.faces] },
    { ...raw, faces: [['A', 'B', 'C', 'A1'], ...raw.faces] },
    { ...raw, camera: { home: { az: 1e9, el: 24 } } }, { ...raw, camera: { home: { az: 20, el: 90 } } },
  ]) invalid(() => validateFigure(value));
  for (const action of [
    { cam: 'face', target: ['B', 'C', 'C1', 'B1'] }, { cam: 'view', az: 275, el: 22 },
    { cam: 'spin', daz: 90, del: -10, dur: 2, tag: '观察平面 {BCC1B1}' }, { cam: 'home' },
    { fig: 'axes', origin: 'C', names: ['x', 'y', 'z'], dirs: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], len: 3 },
  ]) assert.ok(validateFigureAction(action, solid));
  for (const action of [{ cam: 'face', target: ['A', 'B', 'Missing'] }, { cam: 'spin', daz: 99999 }, { cam: 'fly' }, { cam: 'view' }, { fig: 'axes', origin: 'Missing' }]) invalid(() => validateFigureAction(action, solid));
  invalid(() => validateFigureAction({ cam: 'home' }, validateFigure(triangle())));
});

test('figure actions use strict per-operation fields, roles, safe text and bounded numeric values', () => {
  const plane = validateFigure(triangle()), plot = validateFigure(graph());
  for (const action of [
    { fig: 'seg', a: 'A', b: 'B', dash: true, arrow: true, fade: 0.4, at: '连接', delay: 0.2, dur: 1, hold: 4, id: 'line1' },
    { fig: 'poly', pts: ['A', 'B', 'C'], role: 'plane', opacity: 0.5 },
    { fig: 'dot', p: 'A' }, { fig: 'label', p: 'A', text: 'A1' },
    { fig: 'par', a: 'A', b: 'B', n: 2 }, { fig: 'rt', v: 'B', a: 'A', b: 'C', size: 0.3 },
    { fig: 'angle', v: 'A', a: 'B', b: 'C', text: '45°', r: 0.5 },
    { fig: 'text', p: 'A', text: '1', dx: 10, dy: -10 }, { fig: 'text', pos: [1, 2], text: 'x=1' },
  ]) assert.ok(validateFigureAction(action, plane));
  assert.ok(validateFigureAction({ fig: 'curve', f: 'sin(x)', from: -1, to: 3, label: 'y=sin(x)', role: 'given' }, plot));
  for (const action of [
    { fig: 'html' }, { fig: 'grid' }, { fig: 'seg', a: 'A', b: 'Missing' }, { fig: 'seg', a: 'A', b: 'A' },
    { fig: 'seg', a: 'A', b: 'B', stroke: 'red' }, { fig: 'poly', pts: ['A', 'B', 'C'], fill: '#ff0000' },
    { fig: 'poly', pts: ['A', 'B', 'C'], role: 'edge' }, { fig: 'dot', p: 'A', role: 'plane' },
    { fig: 'par', a: 'A', b: 'B', n: 1000 }, { fig: 'rt', v: 'B', a: 'A', b: 'C', size: Infinity },
    { fig: 'dot', p: 'A', dur: -1 }, { fig: 'dot', p: 'A', delay: 1000 }, { fig: 'dot', p: 'A', hold: 1000 },
    { fig: 'text', p: 'A', pos: [1, 2], text: 'x' }, { fig: 'text', text: 'x' },
    { fig: 'label', p: 'A', text: '<svg onload="alert(1)">' }, { fig: 'text', p: 'A', text: 'https://evil.test' },
    { fig: 'text', p: 'A', text: '/etc/passwd' }, { fig: 'text', p: 'A', text: '\\href{evil}{click}' },
    { fig: 'dot', p: 'A', cam: 'home' }, { fig: 'dot', p: 'A', write: 'bad selector' },
    { fig: 'axes', origin: 'B', names: ['x', 'y'] },
    { fig: 'curve', f: 'x' },
  ]) invalid(() => validateFigureAction(action, plane));
  invalid(() => validateFigureAction({ fig: 'curve', f: 'x', from: 3, to: 1 }, plot));
  invalid(() => validateFigureAction({ fig: 'curve', f: 'Math.random()' }, plot));
  invalid(() => validateFigureAction({ fig: 'dot', p: 'A' }, undefined));
});

test('predeclared action points allow forward references and flatten midpoint dependencies without changing input', () => {
  const figure = validateFigure(triangle());
  const actions = [
    { fig: 'seg', a: 'M', b: 'N', id: 'mn' },
    { fig: 'point', name: 'N', mid: ['M', 'C'], show: false },
    { fig: 'point', name: 'M', mid: ['A', 'B'] }, { hide: 'mn' },
  ];
  const before = structuredClone(actions), context = createFigureActionContext(figure, actions);
  const normalized = actions.map(a => validateFigureAction(a, figure, context));
  assert.deepEqual(normalized[1], { fig: 'point', name: 'N', pos: [2, 0.5], show: false });
  assert.deepEqual(normalized[2], { fig: 'point', name: 'M', pos: [0, 1] });
  assert.deepEqual(actions, before);
  assert.deepEqual(normalized[3], { hide: 'mn' });
  for (const sequence of [
    [{ fig: 'point', name: 'M', mid: ['N', 'A'] }, { fig: 'point', name: 'N', mid: ['M', 'B'] }],
    [{ fig: 'point', name: 'M', mid: ['Missing', 'A'] }],
    [{ fig: 'point', name: 'M', pos: [1, 2] }, { fig: 'point', name: 'M', pos: [2, 3] }],
    [{ fig: 'point', name: 'A', pos: [1, 2] }],
    [{ fig: 'dot', p: 'A', id: 'same' }, { fig: 'dot', p: 'B', id: 'same' }],
    Array.from({ length: 97 }, () => ({ write: '文字' })),
  ]) invalid(() => createFigureActionContext(figure, sequence));
  const earlyHide = [{ hide: 'later' }, { fig: 'dot', p: 'A', id: 'later' }];
  const earlyContext = createFigureActionContext(figure, earlyHide);
  invalid(() => validateFigureAction(earlyHide[0], figure, earlyContext));
  invalid(() => validateFigureAction({ hide: 'Missing' }, figure, context));
});

test('default context supports sequential point declarations and rejects undeclared or duplicate action IDs', () => {
  const figure = validateFigure(triangle());
  validateFigureAction({ fig: 'point', name: 'M', mid: ['A', 'B'] }, figure);
  assert.ok(validateFigureAction({ fig: 'dot', p: 'M', id: 'm' }, figure));
  assert.deepEqual(validateFigureAction({ hide: 'm' }, figure), { hide: 'm' });
  invalid(() => validateFigureAction({ fig: 'dot', p: 'M', id: 'm' }, figure));
  invalid(() => validateFigureAction({ fig: 'point', name: 'M', pos: [1, 2] }, figure));
});

test('prototype pollution, getters, exotic arrays and engine internal override keys are never copied', () => {
  let getters = 0;
  const getterPoint = Object.defineProperty({}, 'A', { enumerable: true, get() { getters++; return [1, 2]; } });
  const array = [1, 2]; array.extra = 'bad';
  const getterArray = [1, 2]; Object.defineProperty(getterArray, '0', { enumerable: true, get() { getters++; return 1; } });
  const oddAction = Object.create({ fig: 'dot', p: 'A' });
  for (const value of [
    { ...triangle(), points: JSON.parse('{"__proto__":[1,2]}') },
    { ...triangle(), points: { constructor: [1, 2] } }, { ...triangle(), points: { toString: [1, 2] } },
    JSON.parse('{"type":"graph","__proto__":{"polluted":true}}'),
    Object.assign(Object.create({ inherited: true }), triangle()),
    { ...triangle(), points: getterPoint }, { ...triangle(), points: { A: array } },
    { ...triangle(), points: { A: getterArray } },
  ]) invalid(() => validateFigure(value));
  const figure = validateFigure(triangle());
  for (const action of [oddAction, JSON.parse('{"fig":"dot","p":"A","__proto__":{}}'), { fig: 'dot', p: 'A', kind: 'write' }, { fig: 'dot', p: 'A', op: 'html' }, { fig: 'dot', p: 'A', id: 'constructor' }]) invalid(() => validateFigureAction(action, figure));
  assert.equal(getters, 0);
  assert.equal({}.polluted, undefined);
});
