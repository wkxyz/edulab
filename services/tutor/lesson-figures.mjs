// Public adapter for the trusted lesson engine. Copy only documented data into the
// engine: its SVG renderer and Function-based curve compiler are not a sandbox.
const LIMIT = Object.freeze({ points: 48, faces: 32, vertices: 12, segments: 96, marks: 24, curves: 8, actions: 96, coordinate: 10000 });
const RESERVED = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);
const LINE_ROLES = new Set(['edge', 'given', 'aux', 'key', 'axis']);
const FILL_ROLES = new Set(['tri', 'plane', 'plane2']);
const FIG_OPS = new Set(['seg', 'poly', 'point', 'dot', 'label', 'par', 'rt', 'angle', 'axes', 'curve', 'text']);
const COMMON = ['at', 'delay', 'dur', 'hold', 'id'];
const states = new WeakMap();
const defaultContexts = new WeakMap();

function reject() {
  const error = new Error('UNSUPPORTED_ANIMATION');
  error.code = 'UNSUPPORTED_ANIMATION'; error.status = 400;
  throw error;
}
const own = (o, key) => Object.hasOwn(o, key);
function record(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) reject();
  const keys = Reflect.ownKeys(value);
  if (keys.length > 64) reject();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || RESERVED.has(key) || !descriptor.enumerable || !own(descriptor, 'value') || (allowed && !allowed.includes(key))) reject();
  }
  return value;
}
function list(value, min, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < min || value.length > max) reject();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) reject();
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !descriptor.enumerable || !own(descriptor, 'value')) reject();
  }
  return value;
}
function number(value, min = -LIMIT.coordinate, max = LIMIT.coordinate) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) reject();
  return Object.is(value, -0) ? 0 : value;
}
function boolean(value) { if (typeof value !== 'boolean') reject(); return value; }
function name(value, max = 16) {
  if (typeof value !== 'string' || value.length > max || !/^[A-Za-z][A-Za-z0-9_]*$/.test(value) || RESERVED.has(value)) reject();
  return value;
}
function text(value, max = 80) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f<>`]/.test(value) || /(?:[a-z][a-z0-9+.-]*:\/|(?:javascript|data|vbscript):|\/\/|\\(?:href|url|html\w*|includegraphics|require|def|gdef|newcommand)\b|(?:^|\s)(?:\/[a-z_.]|[a-z]:[\\/]))/i.test(value)) reject();
  return value.trim();
}
function coordinates(value, dimensions) { return list(value, dimensions, dimensions).map(v => number(v)); }
const to3 = value => value.length === 2 ? [...value, 0] : value;
function reference(value, points) { const key = name(value); if (!points.has(key)) reject(); return key; }
function references(value, points, min, max) {
  const result = list(value, min, max).map(v => reference(v, points));
  if (new Set(result).size !== result.length) reject();
  return result;
}
function midpoint(pair, points) { return points.get(pair[0]).map((v, i) => (v + points.get(pair[1])[i]) / 2); }
function role(value, allowed = LINE_ROLES) { if (!allowed.has(value)) reject(); return value; }
function optional(out, source, key, validator) { if (own(source, key)) out[key] = validator(source[key]); }

// This grammar deliberately does not accept JavaScript expressions. Every token
// is parsed, and parentheses are emitted around every operator before handing it
// to the existing engine (which replaces ^ with ** and bare names with Math.*).
const FUNCTIONS = Object.freeze({ sin: Math.sin, cos: Math.cos, tan: Math.tan, sqrt: Math.sqrt, abs: Math.abs, log: Math.log, ln: Math.log, exp: Math.exp });
export function validateGraphExpression(source) {
  if (typeof source !== 'string' || !source.trim() || source.length > 512) reject();
  const tokens = [];
  for (let i = 0; i < source.length;) {
    const char = source[i];
    if (/\s/.test(char)) { i++; continue; }
    if (/[0-9.]/.test(char)) {
      const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d{1,2})?/.exec(source.slice(i));
      if (!match || match[0].length > 24) reject();
      const n = Number(match[0]);
      if (!Number.isFinite(n) || Math.abs(n) > 1000000 || (n !== 0 && Math.abs(n) < 1e-12)) reject();
      tokens.push({ type: 'number', value: n }); i += match[0].length;
    } else if (/[A-Za-z]/.test(char)) {
      const match = /^[A-Za-z]+/.exec(source.slice(i))[0];
      if (match !== 'x' && match !== 'PI' && !own(FUNCTIONS, match)) reject();
      tokens.push({ type: match }); i += match.length;
    } else if ('+-*/^()'.includes(char)) {
      tokens.push({ type: char }); i++;
    } else reject();
    if (tokens.length > 192) reject();
  }
  let index = 0, nodes = 0;
  const peek = type => tokens[index]?.type === type;
  const consume = type => { if (!peek(type)) reject(); return tokens[index++]; };
  function node(code, constant, children = []) {
    const depth = 1 + Math.max(0, ...children.map(child => child.depth));
    if (++nodes > 96 || depth > 24 || code.length > 512) reject();
    return { code, constant, depth };
  }
  function binary(op, left, right) {
    // Small numeric literals and a bounded constant exponent avoid pathological
    // power towers, while x-dependent curves can still contain discontinuities.
    if (op === '^' && right.constant !== undefined && Math.abs(right.constant) > 32) reject();
    let constant;
    if (left.constant !== undefined && right.constant !== undefined) {
      const a = left.constant, b = right.constant;
      constant = op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : op === '/' ? a / b : a ** b;
      if (!Number.isFinite(constant)) reject();
    }
    return node(`(${left.code}${op}${right.code})`, constant, [left, right]);
  }
  function primary(depth) {
    if (depth > 24) reject();
    if (peek('number')) { const n = consume('number').value; return node(String(n), n); }
    if (peek('x')) { consume('x'); return node('x'); }
    if (peek('PI')) { consume('PI'); return node('PI', Math.PI); }
    if (peek('(')) { consume('('); const value = expression(depth + 1); consume(')'); return value; }
    const fn = tokens[index]?.type;
    if (!own(FUNCTIONS, fn)) reject();
    index++; consume('('); const arg = expression(depth + 1); consume(')');
    const constant = arg.constant === undefined ? undefined : FUNCTIONS[fn](arg.constant);
    if (constant !== undefined && !Number.isFinite(constant)) reject();
    return node(`${fn}(${arg.code})`, constant, [arg]);
  }
  function unary(depth) {
    if (depth > 24) reject();
    if (peek('+') || peek('-')) {
      const op = tokens[index++].type, value = unary(depth + 1);
      return node(`(${op}${value.code})`, value.constant === undefined ? undefined : op === '-' ? -value.constant : value.constant, [value]);
    }
    let result = primary(depth);
    if (peek('^')) { consume('^'); result = binary('^', result, unary(depth + 1)); }
    return result;
  }
  function product(depth) {
    let result = unary(depth);
    while (peek('*') || peek('/')) { const op = tokens[index++].type; result = binary(op, result, unary(depth)); }
    return result;
  }
  function expression(depth) {
    let result = product(depth);
    while (peek('+') || peek('-')) { const op = tokens[index++].type; result = binary(op, result, product(depth)); }
    return result;
  }
  const result = expression(0);
  if (index !== tokens.length) reject();
  return result.code;
}

function pointDefinition(value, dimensions, allowed = ['name', 'mid', 'pos', 'on']) {
  record(value, allowed);
  const out = { name: name(value.name) };
  if (own(value, 'mid') === own(value, 'pos')) reject();
  optional(out, value, 'pos', v => coordinates(v, dimensions));
  optional(out, value, 'mid', v => list(v, 2, 2).map(n => name(n)));
  optional(out, value, 'on', v => list(v, 2, 2).map(n => name(n)));
  if ((out.mid && out.mid[0] === out.mid[1]) || (out.on && out.on[0] === out.on[1])) reject();
  return out;
}
function nondegenerateFace(names, points) {
  const [a, b, c] = names.slice(0, 3).map(n => to3(points.get(n)));
  const u = b.map((v, i) => v - a[i]), v = c.map((x, i) => x - a[i]);
  const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const magnitude = Math.hypot(...normal);
  if (magnitude <= 1e-10) reject();
  for (const n of names) {
    const delta = to3(points.get(n)).map((x, i) => x - a[i]);
    if (Math.abs(delta.reduce((sum, x, i) => sum + x * normal[i], 0)) / magnitude > 1e-6) reject();
  }
}

export function validateFigure(value) {
  if (value === undefined) return undefined;
  record(value, ['type', 'points', 'faces', 'edges', 'extra', 'given', 'marks', 'camera', 'zoom', 'center', 'on', 'view', 'tick', 'equalAspect', 'labels', 'curves']);
  if (!['plane2d', 'solid3d', 'graph'].includes(value.type)) reject();
  const dimensions = value.type === 'solid3d' ? 3 : 2;
  const allowed = value.type === 'graph' ? ['view', 'tick', 'equalAspect', 'curves'] : value.type === 'solid3d' ? ['faces', 'camera'] : [];
  for (const field of ['view', 'tick', 'equalAspect', 'curves', 'faces', 'camera']) if (own(value, field) && !allowed.includes(field)) reject();
  const out = { type: value.type, points: {} }, points = new Map();
  const inputPoints = record(own(value, 'points') ? value.points : {});
  for (const key of Object.keys(inputPoints)) {
    name(key); if (points.size >= LIMIT.points) reject();
    const pos = coordinates(inputPoints[key], dimensions); out.points[key] = pos; points.set(key, pos);
  }
  if (value.type !== 'graph' && points.size < (value.type === 'solid3d' ? 4 : 1)) reject();
  if (own(value, 'extra')) out.extra = list(value.extra, 0, LIMIT.points).map(entry => {
    const result = pointDefinition(entry, dimensions);
    if (points.has(result.name) || points.size >= LIMIT.points) reject();
    if (result.mid) result.mid = references(result.mid, points, 2, 2);
    if (result.on) result.on = references(result.on, points, 2, 2);
    points.set(result.name, result.pos || midpoint(result.mid, points));
    return result;
  });
  for (const field of ['edges', 'given']) optional(out, value, field, v => list(v, 0, LIMIT.segments).map(pair => references(pair, points, 2, 2)));
  if (value.type === 'solid3d') {
    out.faces = list(value.faces, 4, LIMIT.faces).map(face => {
      const result = references(face, points, 3, LIMIT.vertices); nondegenerateFace(result, points); return result;
    });
    if (out.faces.reduce((sum, face) => sum + face.length, 0) > 192) reject();
    optional(out, value, 'camera', v => {
      record(v, ['home']); const home = record(v.home, ['az', 'el']);
      return { home: { az: number(home.az, -360, 360), el: number(home.el, -85, 85) } };
    });
  }
  optional(out, value, 'center', v => coordinates(v, dimensions));
  optional(out, value, 'zoom', v => number(v, 0.2, 1));
  optional(out, value, 'labels', boolean);
  optional(out, value, 'on', v => {
    record(v); const result = {};
    for (const key of Object.keys(v)) result[reference(key, points)] = references(v[key], points, 2, 2);
    return result;
  });
  if (value.type === 'graph') {
    const view = own(value, 'view') ? record(value.view, ['xmin', 'xmax', 'ymin', 'ymax']) : { xmin: -5, xmax: 5, ymin: -5, ymax: 5 };
    out.view = Object.fromEntries(['xmin', 'xmax', 'ymin', 'ymax'].map(k => [k, number(view[k])]));
    const width = out.view.xmax - out.view.xmin, height = out.view.ymax - out.view.ymin;
    if (width < 0.0001 || height < 0.0001) reject();
    out.tick = own(value, 'tick') ? number(value.tick, 0.0001, LIMIT.coordinate) : 1;
    if (width / out.tick > 100 || height / out.tick > 100) reject();
    optional(out, value, 'equalAspect', boolean);
  }
  const state = { dimensions, points, type: out.type, figure: out };
  states.set(out, state);
  optional(out, value, 'marks', v => list(v, 0, LIMIT.marks).map(mark => {
    record(mark, ['op', 'v', 'a', 'b', 'role', 'size', 'n', 'r', 'text']);
    if (!['rt', 'par', 'angle'].includes(mark.op)) reject();
    const { op, ...fields } = mark;
    const normalized = normalizeFigureAction({ fig: op, ...fields }, state, { points });
    const { fig, ...rest } = normalized; return { op: fig, ...rest };
  }));
  optional(out, value, 'curves', v => list(v, 0, LIMIT.curves).map(curve => {
    record(curve, ['f', 'role', 'from', 'to', 'label']);
    const { fig, ...rest } = normalizeFigureAction({ fig: 'curve', ...curve }, state, { points });
    return rest;
  }));
  return out;
}

function stateFor(figure) {
  if (!figure || typeof figure !== 'object') reject();
  return states.get(figure) || states.get(validateFigure(figure));
}
function timing(out, action) {
  optional(out, action, 'at', v => typeof v === 'number' ? number(v, 0, 30) : text(v, 80));
  optional(out, action, 'delay', v => number(v, 0, 10));
  optional(out, action, 'dur', v => number(v, 0.05, 10));
  optional(out, action, 'hold', v => number(v, 0.1, 30));
  optional(out, action, 'id', v => name(v, 32));
  return out;
}
function normalizeFigureAction(action, state, context) {
  const { points } = context, out = { fig: action.fig };
  const fields = {
    seg: ['a', 'b', 'role', 'dash', 'arrow', 'fade'], poly: ['pts', 'role', 'opacity'],
    point: ['name', 'mid', 'pos', 'on', 'show'], dot: ['p', 'role'], label: ['p', 'text'],
    par: ['a', 'b', 'role', 'n'], rt: ['v', 'a', 'b', 'role', 'size'], angle: ['v', 'a', 'b', 'role', 'r', 'text'],
    axes: ['origin', 'names', 'len', 'dirs'], curve: ['f', 'role', 'from', 'to', 'label'], text: ['p', 'pos', 'text', 'dx', 'dy', 'role'],
  };
  if (!FIG_OPS.has(action.fig)) reject();
  record(action, ['fig', ...COMMON, ...fields[action.fig]]);
  timing(out, action);
  for (const field of ['a', 'b', 'v', 'p', 'origin']) optional(out, action, field, v => reference(v, points));
  optional(out, action, 'role', v => role(v, action.fig === 'poly' ? FILL_ROLES : LINE_ROLES));
  optional(out, action, 'text', v => text(v));
  switch (action.fig) {
    case 'seg': case 'par':
      if (!out.a || !out.b || out.a === out.b) reject();
      if (action.fig === 'seg') {
        optional(out, action, 'dash', boolean); optional(out, action, 'arrow', boolean);
        optional(out, action, 'fade', v => number(v, 0, 1));
      } else optional(out, action, 'n', v => { number(v, 1, 3); if (!Number.isInteger(v)) reject(); return v; });
      break;
    case 'poly':
      out.pts = references(action.pts, points, 3, LIMIT.vertices);
      nondegenerateFace(out.pts, points);
      optional(out, action, 'opacity', v => number(v, 0, 1));
      break;
    case 'point': {
      const definition = pointDefinition(action, state.dimensions, ['fig', ...COMMON, ...fields.point]);
      const prepared = context.pointActions?.get(action);
      if (context.predeclared && !prepared) reject();
      if (!prepared) {
        if (points.has(definition.name) || points.size >= LIMIT.points) reject();
        if (definition.mid) definition.mid = references(definition.mid, points, 2, 2);
        if (definition.on) definition.on = references(definition.on, points, 2, 2);
        points.set(definition.name, definition.pos || midpoint(definition.mid, points));
      }
      // Resolve midpoint actions to positions: the compiler sorts by narration
      // time, so a point dependency must not rely on source action order.
      out.name = definition.name; out.pos = [...points.get(definition.name)];
      optional(out, definition, 'on', v => references(v, points, 2, 2));
      optional(out, action, 'show', boolean);
      break;
    }
    case 'dot': case 'label': if (!out.p) reject(); break;
    case 'rt': case 'angle':
      if (!out.v || !out.a || !out.b || new Set([out.v, out.a, out.b]).size !== 3) reject();
      if (action.fig === 'rt') optional(out, action, 'size', v => number(v, 0.0001, 1000));
      else optional(out, action, 'r', v => number(v, 0.0001, 1000));
      break;
    case 'axes':
      if (state.type === 'plane2d') reject();
      if (state.type !== 'graph' && !out.origin) reject();
      optional(out, action, 'names', v => list(v, state.dimensions, state.dimensions).map(n => text(n, 8)));
      optional(out, action, 'len', v => number(v, 0.0001, 1000));
      optional(out, action, 'dirs', v => list(v, state.dimensions, state.dimensions).map(d => {
        const result = coordinates(d, 3); if (Math.hypot(...result) < 0.0001) reject(); return result;
      }));
      break;
    case 'curve':
      if (state.type !== 'graph') reject();
      out.f = validateGraphExpression(action.f);
      optional(out, action, 'from', number); optional(out, action, 'to', number);
      optional(out, action, 'label', v => text(v));
      if ((out.from ?? state.figure.view.xmin) >= (out.to ?? state.figure.view.xmax)) reject();
      break;
    case 'text':
      if (own(action, 'p') === own(action, 'pos') || !out.text) reject();
      optional(out, action, 'pos', v => coordinates(v, state.dimensions));
      optional(out, action, 'dx', v => number(v, -200, 200)); optional(out, action, 'dy', v => number(v, -200, 200));
      break;
  }
  return out;
}

// Predeclare all action points to match upstream examples which draw a segment
// before its point declarations. Only this data is resolved, never code.
export function createFigureActionContext(figure, allActions = []) {
  list(allActions, 0, LIMIT.actions);
  if (figure === undefined) {
    for (const action of allActions) {
      record(action);
      if (['fig', 'cam', 'hide'].some(key => own(action, key))) reject();
    }
    return { points: new Map(), ids: new Map(), predeclared: true };
  }
  const state = stateFor(figure);
  const context = { points: new Map(state.points), pointActions: new Map(), ids: new Map(), actionIndexes: new Map(), predeclared: true };
  const definitions = new Map();
  allActions.forEach((action, index) => {
    record(action); context.actionIndexes.set(action, index);
    if (own(action, 'fig') && action.fig === 'point') {
      const definition = pointDefinition(action, state.dimensions, ['fig', ...COMMON, 'name', 'mid', 'pos', 'on', 'show']);
      if (context.points.has(definition.name) || definitions.has(definition.name) || context.points.size + definitions.size >= LIMIT.points) reject();
      definitions.set(definition.name, definition); context.pointActions.set(action, definition);
    }
    if (own(action, 'id') && own(action, 'fig')) {
      const id = name(action.id, 32);
      if (context.ids.has(id)) reject();
      context.ids.set(id, { action, index });
    }
  });
  const visiting = new Set();
  function resolve(key) {
    if (context.points.has(key)) return context.points.get(key);
    const definition = definitions.get(key);
    if (!definition || visiting.has(key)) reject();
    visiting.add(key);
    const pos = definition.pos || definition.mid.map(n => resolve(n)).reduce((a, b) => a.map((v, i) => (v + b[i]) / 2));
    context.points.set(key, pos); visiting.delete(key); return pos;
  }
  for (const key of definitions.keys()) resolve(key);
  for (const definition of definitions.values()) if (definition.on) references(definition.on, context.points, 2, 2);
  return context;
}

export function validateFigureAction(action, figure, context) {
  record(action);
  const selectors = ['fig', 'cam', 'hide'].filter(k => own(action, k));
  if (!selectors.length) return null;
  if (selectors.length !== 1) reject();
  const state = stateFor(figure);
  if (!context) {
    context = defaultContexts.get(figure);
    if (!context) {
      context = { points: new Map(state.points), ids: new Map(), predeclared: false };
      defaultContexts.set(figure, context);
    }
  }
  if (own(action, 'fig')) {
    const out = normalizeFigureAction(action, state, context);
    if (out.id && !context.predeclared) {
      if (context.ids.has(out.id)) reject();
      context.ids.set(out.id, { action });
    }
    return out;
  }
  if (own(action, 'hide')) {
    record(action, ['hide', 'at', 'delay', 'dur']);
    const target = name(action.hide, 32), entry = context.ids.get(target);
    if (!entry || (context.predeclared && (context.actionIndexes.get(action) === undefined || entry.index >= context.actionIndexes.get(action)))) reject();
    return timing({ hide: target }, action);
  }
  if (state.type !== 'solid3d' || !['face', 'view', 'spin', 'home'].includes(action.cam)) reject();
  const fields = { face: ['target'], view: ['az', 'el'], spin: ['daz', 'del'], home: [] };
  record(action, ['cam', 'at', 'delay', 'dur', 'tag', 'tagOut', ...fields[action.cam]]);
  const out = timing({ cam: action.cam }, action);
  optional(out, action, 'tag', v => text(v)); optional(out, action, 'tagOut', v => number(v, 0.1, 30));
  if (action.cam === 'face') {
    out.target = references(action.target, context.points, 3, LIMIT.vertices);
    nondegenerateFace(out.target, context.points);
  } else if (action.cam === 'view') {
    if (!own(action, 'az') && !own(action, 'el')) reject();
    optional(out, action, 'az', v => number(v, -360, 360)); optional(out, action, 'el', v => number(v, -85, 85));
  } else if (action.cam === 'spin') {
    if (!own(action, 'daz') && !own(action, 'del')) reject();
    optional(out, action, 'daz', v => number(v, -360, 360)); optional(out, action, 'del', v => number(v, -85, 85));
  }
  return out;
}
