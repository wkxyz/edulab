/* Trusted JSON dispatcher for the vendored edulab engines. This file, and only
 * this file, supplies scene callbacks. Model output is never evaluated as code. */
const PROBLEM = null;
const TAGS = Object.create(null);
const SC = Object.create(null);

(() => {
  'use strict';
  const spec = window.ANIMATION_SPEC;
  const chemistry = spec.capability === 'chem-video';
  const physics = spec.capability === 'physics-video';
  const colour = o => C[o.color] || C.blue;
  const lineCue = (sc, line, fraction) => {
    const l = sc.lines[line];
    return l.start - sc.start + (l.end - l.start) * fraction;
  };
  const progress = (a, lt, timelineScene) => {
    const start = lineCue(timelineScene, a.line, a.fraction);
    const end = lineCue(timelineScene, a.endLine, a.endFraction);
    return clamp((lt - start) / Math.max(0.01, end - start));
  };
  function offset(m, t) {
    if (m.kind === 'constantAcceleration') return m.velocity.map((v, i) => (v * t + 0.5 * m.acceleration[i] * t * t) * m.scale);
    if (m.kind === 'circular') return [Math.cos(m.phase + m.angularVelocity * t) - Math.cos(m.phase), Math.sin(m.phase + m.angularVelocity * t) - Math.sin(m.phase)].map(v => v * m.radius * m.scale);
    return m.amplitude.map(v => v * (Math.sin(m.phase + m.angularFrequency * t) - Math.sin(m.phase)) * m.scale);
  }
  function stateFor(o, scene, timelineScene, lt) {
    const state = {at: o.at ? [...o.at] : null, reveal: 1, highlight: 0, translate: [0, 0], rotate: 0, scale: 1, reaction: 1, flow: 1};
    for (const a of scene.actions) {
      if (a.target !== o.id) continue;
      const p = progress(a, lt, timelineScene);
      switch (a.kind) {
        case 'reveal': state.reveal = p; break;
        case 'highlight': state.highlight = Math.sin(p * PI); break;
        case 'react': state.reaction = p; break;
        case 'flow': state.flow = p; break;
        case 'transform': state.translate = a.translate.map(v => v * eio(p)); state.rotate = a.rotate * eio(p); state.scale = lerp(1, a.scale, eio(p)); break;
        case 'move': {
          // Physical time is linear. It is never passed through an easing curve.
          const start = lineCue(timelineScene, a.line, a.fraction);
          const duration = lineCue(timelineScene, a.endLine, a.endFraction) - start;
          const t = physics ? simT(lt, start, duration, a.motion.duration) : p * a.motion.duration;
          const d = offset(a.motion, t);
          state.at = o.at.map((v, i) => v + d[i]);
          state.motion = a.motion; state.physicalTime = t;
          break;
        }
      }
    }
    if (state.at) state.at = state.at.map((v, i) => v + state.translate[i]);
    return state;
  }
  const interpolate = (points, x) => {
    if (x <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i++) {
      if (x <= points[i][0]) return lerp(points[i - 1][1], points[i][1], (x - points[i - 1][0]) / (points[i][0] - points[i - 1][0]));
    }
    return points[points.length - 1][1];
  };
  function graphObject(o, s) {
    const [xmin, xmax] = o.xRange, [ymin, ymax] = o.yRange;
    const [left, top] = o.at, width = o.width, height = o.height;
    const oy = top + ymax / (ymax - ymin) * height;
    const map = ([x, y]) => [left + (x - xmin) / (xmax - xmin) * width, top + (ymax - y) / (ymax - ymin) * height];
    if (physics || chemistry) {
      const g = graph({ox: left, oy, w: width, h: height, xr: o.xRange, yr: o.yRange, xl: o.xLabel, yl: o.yLabel});
      g.draw(s.reveal);
      g.curve(x => interpolate(o.points, x), o.points[0][0], lerp(o.points[0][0], o.points[o.points.length - 1][0], s.reveal), {c: colour(o)});
    } else {
      // The numerical samples are data; no graph expression is compiled.
      draw([[left, top], [left, top + height], [left + width, top + height]], {p: s.reveal, c: C.gray, w: 3});
      draw(o.points.map(map), {p: s.reveal, c: colour(o), w: 5});
      txt(o.xLabel, left + width - 15, top + height + 27, {size: 25, f: MF, c: C.gray});
      txt(o.yLabel, left + 14, top + 20, {size: 25, f: MF, c: C.gray, al: 'left'});
    }
    if (o.label) txt(o.label, left + width / 2, top + 25, {size: 26, c: colour(o), p: s.reveal});
  }
  function renderObject(o, s, scene, timelineScene, states, equations, lt) {
    if (s.reveal <= 0.001) return;
    const col = colour(o), p = s.reveal, at = s.at || o.at;
    const options = {c: col, p, w: 4, label: o.label};
    let points = o.points;
    if (points && (s.rotate || s.translate.some(v => v) || s.scale !== 1)) points = movePoly(points, s.translate[0], s.translate[1], s.rotate, s.scale);
    if (s.highlight > 0.001) {
      if (points) glow(points, C.yellow, s.highlight, 25);
      else if (at) circ(at[0], at[1], (o.radius || 45) + 12, {c: C.yellow, a: s.highlight * 0.7, w: 8, rough: 0.6});
    }
    if (s.motion && physics && s.physicalTime > 0) {
      const origin = o.at;
      trail(t => {const d = offset(s.motion, t); return origin.map((v, i) => v + d[i]);}, 0, s.physicalTime, {c: col, dt: Math.max(s.motion.duration / 96, 0.01), a: 0.4});
    }
    switch (o.kind) {
      case 'polyline': draw(points, options); break;
      case 'polygon': fillPts(points, col, 0.12 * p); draw([...points, points[0]], options); break;
      case 'circle': circ(at[0], at[1], o.radius * s.scale, options); break;
      case 'point': dot(at[0], at[1], col, o.radius * p); break;
      case 'angle': if (o.right) rightM(at, o.a, o.b, col, o.radius, p); else angM(at, o.a, o.b, col, o.radius, p); break;
      case 'text': txt(o.text, at[0], at[1], {size: o.size, c: col, p}); break;
      case 'graph': graphObject(o, s); break;
      case 'solid': {
        const previous = {...CAM, target: [...CAM.target]};
        Object.assign(CAM, {cx: at[0], cy: at[1], s: o.scale * s.scale, yaw: o.yaw + s.rotate, pitch: o.pitch, target: [0, 0, 0]});
        for (const [a, b, hidden] of o.edges) L3(o.vertices[a], o.vertices[b], {c: col, p, hidden});
        Object.assign(CAM, previous);
        break;
      }
      case 'ground': ground(points[0], points[1], options); break;
      case 'incline': incline(at, o.angle, o.run, o.direction, options); break;
      case 'block': block(at, o.width, o.height, o.angle, options); break;
      case 'ball': ball(at[0], at[1], o.radius, options); break;
      case 'force': {
        let from = at;
        if (o.body) {
          const body = scene.objects.find(item => item.id === o.body), bodyState = states.get(o.body);
          from = bodyState.at.map((v, i) => v + (o.at[i] - body.at[i]));
        }
        vec(from, o.vector, {...options, size: 28});
        break;
      }
      case 'spring': spring(points[0], points[1], {...options, n: o.coils}); break;
      case 'pulley': grp(p, () => pulley(at, o.radius, lt * 0.4, options)); break;
      case 'ray': ray(points, p, {c: col, pulse: s.flow > 0}); break;
      case 'glass': glassBlock(at[0], at[1], o.width, o.height, o.angle, p); break;
      case 'magneticField': bField(...o.rect, o.direction, {...options, gap: o.gap}); break;
      case 'electricField': eField(...o.rect, {right: 0, down: PI / 2, left: PI, up: -PI / 2}[o.direction], {...options, gap: o.gap}); break;
      case 'charge': grp(p, () => charge(at[0], at[1], o.sign, o.radius, options)); break;
      case 'bridge': {
        const eq = equations.get(o.equation); if (!eq) break;
        const left = eq.items[o.fromSpecies], right = eq.items[o.toSpecies], x0 = eqX(left, o.element), x1 = eqX(right, o.element);
        // Bridges live in the demonstration region, with ties to the equation.
        const y = o.toState > o.fromState ? 405 : 590, cc = o.toState > o.fromState ? C.blue : C.red;
        const from = [Math.min(820, Math.max(110, 170 + o.fromSpecies * 70)), y];
        const to = [Math.min(820, Math.max(360, 600 + (o.toSpecies - 2) * 55)), y];
        const path = bridge(from, to, `${o.element}：${o.toState > o.fromState ? '失去' : '得到'} ${o.electrons}e^-`, p, {c: cc, side: -1, h: 48, size: 27});
        valence(from[0], y + 10, String(o.fromState), p, cc, 1);
        valence(to[0], y + 10, String(o.toState), p, cc, 1);
        eFlow(path, p * s.flow, {n: Math.min(12, o.electrons), c: cc});
        // x0/x1 are obtained from the actual equation layout, not model pixels.
        if (s.highlight > 0) {glow([[x0 - 12, 245], [x0 + 12, 245]], cc, s.highlight);glow([[x1 - 12, 245], [x1 + 12, 245]], cc, s.highlight);}
        break;
      }
      case 'tally': tally(at[0], at[1], o.rows, {p, u: Math.min(14, 200 / Math.max(1, ...o.rows.map(r => r.l))), rh: Math.min(56, 360 / Math.max(1, o.rows.length))}); break;
      case 'ice': {
        const eq = scene.objects.find(item => item.id === o.equation);
        const amount = o.extent * s.reaction;
        const delta = o.initial.map((_, i) => (i < eq.l.length ? -1 : 1) * eq.coefficients[i] * amount);
        const final = o.initial.map((n, i) => n + delta[i]);
        const format = v => String(Math.round(v * 1000) / 1000);
        const cols = [...eq.l, ...eq.r].map((f, i) => (eq.coefficients[i] === 1 ? '' : eq.coefficients[i]) + f);
        iceTable(at[0], at[1], {cols, rows: ['起始', '转化', '结果'], unit: o.unit, cells: [o.initial.map(format), delta.map(v => (v > 0 ? '+' : '') + format(v)), final.map(format)], cw: Math.min(145, 620 / cols.length), lw: 100, rh: 70, p});
        break;
      }
      case 'particles': {
        const eq = scene.objects.find(item => item.id === o.equation), extent = Math.min(o.extent, Math.floor(o.extent * s.reaction + 1e-8));
        const names = [...eq.l, ...eq.r], groups = names.map((name, i) => ({name, n: o.initial[i] + (i < eq.l.length ? -1 : 1) * eq.coefficients[i] * extent}));
        const [x0, y0, x1, y1] = o.rect;
        draw([[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]], {p, c: C.gray, w: 3});
        grp(p, () => particles(o.rect, groups, {r: o.radius, speed: 0.06}));
        const label = groups.filter(g => g.n).map(g => `${g.name}×${g.n}`).join('  ');
        mtx(label, (x0 + x1) / 2, y0 + 25, {size: Math.min(25, 600 / Math.max(1, label.length)), c: C.yellow, p});
        txt('每粒代表一份分子（示意）', (x0 + x1) / 2, y1 - 18, {size: 20, c: C.gray, p});
        break;
      }
      case 'beaker': beaker(at[0], at[1], {w: o.width, h: o.height, level: o.level, c: col, label: o.label, p}); if (o.bubbles) bubbles(at[0] - o.width * 0.4, at[0] + o.width * 0.4, at[1] - 12, at[1] - o.height * o.level, p * s.flow, {n: 10}); break;
      case 'molMap': molMap(at[0], at[1], {r: 150, vals: o.values, p}); break;
    }
    if (o.label && at && !['text','graph','block','beaker','force','charge','molMap'].includes(o.kind)) {
      const labelY = Math.min(835, at[1] + (o.radius || 20) + 30);
      txt(o.label, at[0], labelY, {size: 27, c: col, p});
    }
  }

  for (const [index, scene] of spec.scenes.entries()) {
    TAGS[scene.id] = [String(index + 1).padStart(2, '0'), scene.title, ''];
    const timelineScene = TL.scenes[index];
    SC[scene.id] = (lt, S) => {
      const states = new Map(scene.objects.map(o => [o.id, stateFor(o, scene, timelineScene, lt)]));
      const equations = new Map();
      for (const o of scene.objects) {
        if (o.kind !== 'equation') continue;
        const s = states.get(o.id);
        eqStrip(s.reveal);
        const formulaWidth = [...o.l, ...o.r].reduce((sum, f) => sum + mwidth(f, 48), 0) + o.coefficients.length * 65 + 170;
        const size = Math.max(24, Math.min(48, 48 * 1740 / Math.max(1740, formulaWidth)));
        const layout = equation({l: o.l, r: o.r, k: o.coefficients, arrow: o.arrow, above: o.above, below: o.below}, 960, EQY, {size, p: s.reveal});
        equations.set(o.id, layout);
      }
      ctx.save();
      ctx.beginPath(); ctx.rect(60, chemistry ? 310 : 110, 840, chemistry ? 550 : 750); ctx.clip();
      for (const o of scene.objects) if (o.kind !== 'equation') renderObject(o, states.get(o.id), scene, timelineScene, states, equations, lt);
      ctx.restore();
      if (scene.board.length) {
        board(1);
        scene.board.forEach((row, i) => {
          const widthUnits = [...row.text].reduce((n, c) => n + (c.charCodeAt(0) > 255 ? 1 : 0.55), 0);
          const size = Math.min(36, 810 / Math.max(1, widthUnits));
          const fn = physics || chemistry ? bm : bl;
          fn(i, row.text, S.at(row.line, row.fraction), lt, {c: C[row.color], size});
        });
      }
    };
  }

  // Keep narration-line indices stable while displaying short subtitle chunks.
  // The engines' default caption formatter assumes very short narration lines.
  subtitles = t => {
    const caption = TL.captions.find(c => t >= c.at && t < c.end);
    if (!caption) return;
    ctx.save(); ctx.fillStyle = chemistry || physics ? 'rgba(8,20,26,.94)' : 'rgba(255,253,246,.95)';
    ctx.beginPath(); ctx.roundRect(80, 904, 1760, caption.en ? 142 : 104, 18); ctx.fill(); ctx.restore();
    if (physics || chemistry) mtx(caption.text, 960, 951, {size: 40, f: SUB, c: C.ink, bold: true});
    else txt(plain(caption.text), 960, 951, {size: 40, f: SUB, c: C.ink, bold: true});
    if (caption.en) {
      const english = wrap(caption.en, `28px ${EN}`, 1650);
      english.forEach((line, i) => txt(line, 960, 995 + i * 30, {size: 28, f: EN, c: C.gray}));
    }
  };

  // The upstream engine fades the whole scene to its background at t=0, while
  // speech-driven reveal actions start at the first voice cue (normally 2.2s).
  // Paint the original question after that fade so even the first exported
  // frame is useful. This overlay ends before the first spoken line; it never
  // covers the diagram, board or subtitles during the actual explanation.
  const openingEnd = TL.scenes[0].lines[0].start;
  let openingLayout;
  function openingLines(source, size, bold = false) {
    ctx.font = `${bold ? 'bold ' : ''}${size}px ${SUB}`;
    const lines = []; let current = '';
    for (const character of source.replace(/\s+/g, ' ').trim()) {
      if (current && ctx.measureText(current + character).width > 1720) {
        lines.push(current.trimEnd()); current = character === ' ' ? '' : character;
      } else current += character;
    }
    if (current) lines.push(current);
    return lines;
  }
  function questionOpening(t) {
    if (t < 0 || t >= openingEnd) return;
    if (!openingLayout) {
      const title = openingLines(spec.meta.title, 36, true);
      const bodyY = 168 + (title.length - 1) * 47 + 66;
      let size = 42, lines;
      for (; size >= 20; size--) {
        lines = openingLines(spec.meta.problem, size);
        if ((lines.length - 1) * size * 1.3 + size <= 840 - bodyY) break;
      }
      openingLayout = {title, bodyY, lines, size: Math.max(20, size)};
    }
    const alpha = clamp((openingEnd - t) / Math.min(0.35, openingEnd));
    grp(alpha, () => {
      ctx.save();
      ctx.fillStyle = physics || chemistry ? THEME.cardSolid : '#fffdf7';
      ctx.beginPath(); ctx.roundRect(60, 86, 1800, 790, 24); ctx.fill();
      ctx.strokeStyle = C.blue; ctx.lineWidth = 3; ctx.stroke();
      ctx.restore();
      txt('题目', 100, 118, {size: 24, f: SUB, c: C.blue, al: 'left', bold: true});
      openingLayout.title.forEach((line, i) => txt(line, 960, 168 + i * 47, {size: 36, f: SUB, c: C.ink, bold: true}));
      openingLayout.lines.forEach((line, i) => txt(line, 100, openingLayout.bodyY + i * openingLayout.size * 1.3, {size: openingLayout.size, f: SUB, c: C.ink, al: 'left'}));
    });
  }
  const drawEngineFrame = renderFrame;
  renderFrame = t => {drawEngineFrame(t); questionOpening(t);};
  // boot()/the interactive loop use the global binding; MP4 rendering uses the
  // window property. Updating both keeps the first frame identical in each.
  window.renderFrame = renderFrame;

  window.animationStateAt = t => {
    let index = TL.scenes.findIndex(s => t >= s.start && t < s.end);
    if (index < 0) index = t < 0 ? 0 : TL.scenes.length - 1;
    const scene = spec.scenes[index], ts = TL.scenes[index], lt = t - ts.start;
    return {scene: scene.id, objects: Object.fromEntries(scene.objects.map(o => [o.id, stateFor(o, scene, ts, lt)]))};
  };
  window.ANIMATION_REPORT = {engine: spec.capability, trustedDispatcher: true, scenes: spec.scenes.length, objects: spec.scenes.reduce((n, s) => n + s.objects.length, 0), actions: spec.scenes.reduce((n, s) => n + s.actions.length, 0), timing: 'speech-line-fractions', errors: []};
})();
