import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'parse5';
import { PerspectiveCamera, Vector3, Euler } from 'three';
import { makeStandalonePreview, chemistryCameraFrame } from '../artifact-assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const nodes = node => [node, ...(node.childNodes || []).flatMap(nodes)];
const attr = (node, key) => node.attrs?.find(a => a.name === key)?.value;
const page = body => `<!DOCTYPE html><html><head></head><body>${body}</body></html>`;
function wav() {
  const data = Buffer.alloc(48);
  data.write('RIFF'); data.writeUInt32LE(40, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(24000, 24); data.writeUInt32LE(48000, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(4, 40);
  return data;
}

test('all three real interactive templates inline their own pinned dependencies', async () => {
  for (const [kind, file] of [['solid-geometry', 'lesson.html'], ['analytic-geometry', 'board.html'], ['chem-reaction', 'reaction.html']]) {
    const original = await fs.readFile(path.join(ROOT, 'skills', `edu-${kind}`, 'template', file), 'utf8');
    const html = await makeStandalonePreview(original, { kind });
    const elements = nodes(parse(html));
    assert.ok(elements.some(n => attr(n, 'http-equiv') === 'Content-Security-Policy'));
    assert.ok(elements.some(n => n.tagName === 'style' && n.childNodes?.[0]?.value.includes('data:font/woff2;base64,')), kind);
    assert.equal(elements.filter(n => n.tagName === 'script' && attr(n, 'src')).length, 0, kind);
    assert.equal(elements.filter(n => n.tagName === 'link' || attr(n, 'type') === 'importmap' || attr(n, 'type') === 'module').length, 0, kind);
    assert.ok(Buffer.byteLength(html) < 30 * 1024 * 1024);
    if (kind === 'solid-geometry') {
      assert.match(html, /data-local-asset="three-0\.160\.0-lesson"/);
      assert.match(html, /data-local-asset="mathjax-compat"/);
      assert.match(html, /\.step-content \.katex-display/);
      assert.match(html, /\.answer-card > div:first-child > span\s*\{/);
      assert.doesNotMatch(html, /\.answer-card span\s*\{/);
      assert.doesNotMatch(html, /data-local-asset="three-0\.128\.0"/);
    } else if (kind === 'chem-reaction') {
      assert.match(html, /data-local-asset="three-0\.128\.0"/);
      assert.match(html, /data-local-asset="orbitcontrols-0\.128\.0"/);
      assert.match(html, /new ResizeObserver\(onResize\)\.observe\(container\)/);
      assert.match(html, /fitChemistryPreview\(true\)/);
      assert.match(html, /body>main>div\{min-width:0;min-height:0\}/);
      assert.doesNotMatch(html, /data-local-asset="three-0\.160\.0-lesson"/);
    } else assert.match(html, /\.lg\\:h-screen/);
  }
});

function chemistryFixtures() {
  const code = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('chemistry_view_fixture',sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps({name:module.K.assemble_data(builder()) for name,builder in module.REGISTRY.items()}))`;
  return JSON.parse(execFileSync(process.env.PYTHON || 'python3', ['-B', '-c', code, path.join(ROOT, 'skills/edu-chem-reaction/scripts/generate.py')], { maxBuffer: 1000000 }).toString());
}

test('every real chemistry reaction stays inside the camera through phases at desktop and mobile canvas sizes', () => {
  const fixtures = chemistryFixtures();
  for (const [name, data] of Object.entries(fixtures)) {
    const fragments = new Map((data.fragments || []).map(f => [f.id, f]));
    for (const [width, height] of [[638, 692], [390, 311], [320, 260], [768, 311]]) {
      for (const direction of [[0, 4, 13], [8, 3, 10], [-10, 5, 8]]) {
        const frame = chemistryCameraFrame(data, width, height, direction);
        const camera = new PerspectiveCamera(45, width / height, 0.1, frame.far);
        camera.position.fromArray(frame.position); camera.lookAt(new Vector3().fromArray(frame.target)); camera.updateMatrixWorld();
        for (const progress of [0, 0.2, 0.4, 0.55, 0.7, 0.85, 1]) {
          for (const atom of data.atoms) {
            const fragment = data.meta.engine === 'mechanism' && fragments.get(atom.frag);
            let center;
            if (fragment && atom.flocal) {
              const a = progress < 0.4 ? fragment.K0 : fragment.K1;
              const b = progress < 0.4 ? fragment.K1 : progress <= 0.7 ? fragment.K1 : fragment.K2;
              const t = progress < 0.4 ? progress / 0.4 : progress <= 0.7 ? 0 : (progress - 0.7) / 0.3;
              const rot = a.rot.map((n, i) => n + (b.rot[i] - n) * t);
              center = new Vector3().fromArray(atom.flocal).applyEuler(new Euler(...rot)).add(new Vector3().fromArray(a.pos).lerp(new Vector3().fromArray(b.pos), t));
            } else {
              const t = Math.max(0, Math.min(1, (progress - 0.4) / 0.3));
              center = new Vector3().fromArray(atom.start).lerp(new Vector3().fromArray(atom.end), t * t * (3 - 2 * t));
            }
            // Project the outer sphere's enclosing cube, including motion noise.
            const radius = atom.radius * 1.07 + 0.11;
            for (let corner = 0; corner < 8; corner++) {
              const projected = center.clone().add(new Vector3(...[0, 1, 2].map(i => ((corner >> i) & 1 ? 1 : -1) * radius))).project(camera);
              assert.ok(Math.abs(projected.x) <= 0.8 && Math.abs(projected.y) <= 0.64 && projected.z > -1 && projected.z < 1,
                `${name} ${width}x${height} phase=${progress} atom=${atom.id}`);
            }
          }
        }
      }
    }
  }
});

test('browser regression: chemistry viewport fits without document overflow and solid answer math stays white', { skip: process.env.PREVIEW_BROWSER_TESTS !== '1' }, async () => {
  const { chromium } = await import('playwright');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-layout-browser-'));
  let browser;
  try {
    const raw = path.join(dir, 'chemistry.html');
    execFileSync(process.env.PYTHON || 'python3', ['-B', path.join(ROOT, 'skills/edu-chem-reaction/scripts/generate.py'), 'combustion_ch4', raw]);
    const chemistry = await makeStandalonePreview(await fs.readFile(raw, 'utf8'), { kind: 'chem-reaction' });
    const solidFile = path.join(dir, 'solid.html');
    execFileSync(process.env.PYTHON || 'python3', ['-B', path.join(ROOT, 'skills/edu-solid-geometry/scripts/generate.py'), 'pyramid', solidFile]);
    const solid = await makeStandalonePreview(await fs.readFile(solidFile, 'utf8'), { kind: 'solid-geometry' });
    browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'], ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
    for (const width of [1100, 768, 390, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 692 } });
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => route.abort());
      await page.setContent(chemistry, { waitUntil: 'load' });
      await page.waitForFunction(() => document.querySelector('#canvas-container>canvas') && document.querySelectorAll('#stepper button').length === 3);
      for (const progress of [0, 100]) {
        await page.evaluate(value => { const slider = document.getElementById('reaction-slider'); slider.value = value; slider.dispatchEvent(new Event('input')); }, progress);
        await page.waitForTimeout(120);
        const layout = await page.evaluate(() => {
          const viewport = document.getElementById('canvas-container').getBoundingClientRect();
          const panel = document.querySelector('body>main>div:nth-child(2)').getBoundingClientRect();
          const controls = [...document.querySelectorAll('#stepper>button')].map(el => el.getBoundingClientRect().right);
          const labels = [...document.querySelectorAll('#labels-overlay>div')].filter(el => Number(getComputedStyle(el).opacity) > 0.9).map(el => { const rect = el.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }; });
          return { width: innerWidth, scroll: document.documentElement.scrollWidth, panelRight: panel.right, controls, labels, viewport: { left: viewport.left, right: viewport.right, top: viewport.top, bottom: viewport.bottom } };
        });
        assert.ok(layout.scroll <= width + 1 && layout.panelRight <= width + 1, `overflow at ${width}px`);
        assert.ok(layout.controls.every(right => right <= layout.panelRight + 1), `stepper clips at ${width}px`);
        for (const label of layout.labels) assert.ok(label.left >= layout.viewport.left - 1 && label.right <= layout.viewport.right + 1 && label.top >= layout.viewport.top - 1 && label.bottom <= layout.viewport.bottom + 1, `label clips at ${width}px`);
      }
      await page.getByRole('button', { name: '复位', exact: true }).click();
      assert.deepEqual(errors, []);
      await page.setContent(solid, { waitUntil: 'load' });
      await page.waitForSelector('.answer-value .katex');
      const colors = await page.locator('.answer-value .katex span').evaluateAll(elements => [...new Set(elements.map(el => getComputedStyle(el).color))]);
      assert.deepEqual(colors, ['rgb(255, 255, 255)']);
      await page.close();
    }
  } finally { await browser?.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('board KaTeX file URLs use installed assets and optional fonts use system fallback', async () => {
  const html = await makeStandalonePreview(page('<link rel="stylesheet" href="file:///nonexistent/node_modules/katex/dist/katex.min.css"><link rel="stylesheet" href="file:///nonexistent/node_modules/@fontsource/noto-sans-sc/400.css"><script src="file:///nonexistent/node_modules/katex/dist/katex.min.js"></script>'), { kind: 'math-video' });
  assert.doesNotMatch(html, /file:\/\//);
  assert.match(html, /data:font\/woff2;base64,/);
  assert.match(html, /data-local-asset="katex"/);
});

test('local mixed audio and clip references embed, preserving unrelated playback logic', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-audio-'));
  try {
    await fs.writeFile(path.join(dir, 'audio.wav'), wav());
    await fs.writeFile(path.join(dir, 'speech-2.wav'), wav());
    const playback = 'const seek=(t)=>{audio.currentTime=t;audio.play().catch(()=>{});};';
    const html = await makeStandalonePreview(page(`<audio id="audio" src="audio.wav"></audio><script>const clips=[{"file":${JSON.stringify(pathToFileURL(path.join(dir, 'speech-2.wav')).href)}}];${playback}</script>`), { kind: 'math-video', jobDir: dir });
    assert.match(html, /src="data:audio\/wav;base64,/);
    assert.match(html, /"file":"data:audio\/wav;base64,/);
    assert.ok(html.includes(playback));
    assert.doesNotMatch(html, /file:\/\/|speech-2\.wav|src="audio\.wav"/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('unknown remote, file, relative fetch and module dependencies fail closed', async () => {
  const malicious = [
    '<script src="https://evil.example/loader.js"></script>', '<img src="https://evil.example/pixel">',
    '<link rel="stylesheet" href="file:///etc/passwd">', '<script src="./engine.js"></script>',
    '<style>@import "https://evil.example/font.css";</style>', '<style>x{background:url(./image.png)}</style>',
    '<script>fetch("./lesson.json")</script>', '<script>const x="file:///etc/passwd";</script>',
    '<script type="module">import x from "https://evil.example/esm.js";</script>',
    '<script type="module">import x from "node:fs";</script>',
    '<script>new Audio("https://evil.example/clip.mp3")</script>', '<iframe srcdoc="bad"></iframe>',
    '<img srcset="https://evil.example/x 2x">', '<meta http-equiv="refresh" content="1;url=https://evil.example">',
  ];
  for (const body of malicious) await assert.rejects(makeStandalonePreview(page(body), { kind: 'solid-geometry' }), /INVALID_PREVIEW_(?:ASSET|IMPORT)/);
});

test('only allowlisted bounded regular WAV files in the same job directory can embed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-invalid-'));
  try {
    await fs.writeFile(path.join(dir, 'secret.wav'), wav());
    await fs.writeFile(path.join(dir, 'audio.wav'), 'not-wave');
    for (const value of ['../audio.wav', 'build/mix.wav', 'secret.wav', '/etc/passwd', 'audio.wav']) {
      await assert.rejects(makeStandalonePreview(page(`<audio src="${value}"></audio>`), { kind: 'math-video', jobDir: dir }));
    }
    await fs.symlink(path.join(dir, 'secret.wav'), path.join(dir, 'mix.wav'));
    await assert.rejects(makeStandalonePreview(page('<audio src="mix.wav"></audio>'), { kind: 'physics-video', jobDir: dir }));
    const handle = await fs.open(path.join(dir, 'audio.wav'), 'w');
    await handle.truncate(20 * 1024 * 1024 + 1); await handle.close();
    await assert.rejects(makeStandalonePreview(page('<audio src="audio.wav"></audio>'), { kind: 'chem-video', jobDir: dir }), /PREVIEW_TOO_LARGE/);
    await assert.rejects(makeStandalonePreview(page('x'.repeat(30 * 1024 * 1024)), { kind: 'math-video' }), /PREVIEW_TOO_LARGE/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
