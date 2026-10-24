import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'parse5';
import { makeStandalonePreview } from '../artifact-assets.mjs';

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
      assert.doesNotMatch(html, /data-local-asset="three-0\.128\.0"/);
    } else if (kind === 'chem-reaction') {
      assert.match(html, /data-local-asset="three-0\.128\.0"/);
      assert.match(html, /data-local-asset="orbitcontrols-0\.128\.0"/);
      assert.doesNotMatch(html, /data-local-asset="three-0\.160\.0-lesson"/);
    } else assert.match(html, /\.lg\\:h-screen/);
  }
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
