import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parse, serialize, parseFragment } from 'parse5';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAX_HTML = 30 * 1024 * 1024;
const MAX_AUDIO = 20 * 1024 * 1024;
const KINDS = new Set(['solid-geometry', 'analytic-geometry', 'chem-reaction', 'math-video', 'physics-video', 'chem-video']);
const KATEX = path.dirname(require.resolve('katex/dist/katex.min.js'));
const THREE = path.dirname(path.dirname(require.resolve('three')));
const LEGACY = path.dirname(require.resolve('three-legacy'));
const memory = new Map();
const moduleCache = new Map();
const invalid = () => { throw new Error('INVALID_PREVIEW_ASSET'); };
const tooLarge = () => { throw new Error('PREVIEW_TOO_LARGE'); };
const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value;
const source = node => (node.childNodes || []).map(n => n.value || '').join('');
function textNode(node, value) { node.childNodes = [{ nodeName: '#text', value, parentNode: node }]; }
function replaceNode(node, html) {
  const parent = node.parentNode, i = parent.childNodes.indexOf(node);
  const replacements = parseFragment(html).childNodes;
  for (const replacement of replacements) replacement.parentNode = parent;
  parent.childNodes.splice(i, 1, ...replacements);
}
const inline = (code, label = '') => `<script${label ? ` data-local-asset="${label}"` : ''}>${code.replace(/<\/script/gi, '<\\/script')}</script>`;
const style = css => `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`;
function cached(key, fn) {
  if (!memory.has(key)) memory.set(key, Promise.resolve().then(fn).catch(error => { memory.delete(key); throw error; }));
  return memory.get(key);
}
const readLibrary = file => cached(file, () => fs.readFile(file, 'utf8'));

// All files below come from pinned npm packages. No input URL becomes a path to read.
function katexScript(auto = false) {
  return readLibrary(path.join(KATEX, auto ? 'contrib/auto-render.min.js' : 'katex.min.js'));
}
function katexCss() {
  return cached('katex-css', async () => {
    let css = await readLibrary(path.join(KATEX, 'katex.min.css'));
    // WOFF2 is supported by the same browsers as the lesson engines. One format
    // avoids tripling every embedded font.
    css = css.replace(/src:([^;]+);/g, (whole, sources) => {
      const woff = sources.match(/url\([^)]*\.woff2\)\s*format\([^)]+\)/);
      return woff ? `src:${woff[0]};` : whole;
    });
    const names = [...new Set([...css.matchAll(/url\(fonts\/(KaTeX_[A-Za-z0-9-]+\.woff2)\)/g)].map(x => x[1]))];
    for (const name of names) {
      const data = await fs.readFile(path.join(KATEX, 'fonts', name));
      css = css.replaceAll(`url(fonts/${name})`, `url(data:font/woff2;base64,${data.toString('base64')})`);
    }
    checkCss(css);
    return css;
  });
}
function localTailwind(kind) {
  if (!['analytic-geometry', 'chem-reaction'].includes(kind)) invalid();
  return cached(`tailwind:${kind}`, async () => {
    const name = kind === 'analytic-geometry' ? 'board.html' : 'reaction.html';
    // Compile only fixed upstream template content, not model-supplied arbitrary
    // Tailwind classes. There are two bounded cached compilations per process.
    const template = await fs.readFile(path.join(HERE, '../../skills', `edu-${kind}`, 'template', name), 'utf8');
    const result = await postcss([tailwindcss({ content: [{ raw: template, extension: 'html' }], theme: { extend: {} }, plugins: [] })])
      .process('@tailwind base;\n@tailwind components;\n@tailwind utilities;', { from: undefined });
    checkCss(result.css);
    return result.css;
  });
}
function checkCss(css) {
  if (/@import\b/i.test(css)) invalid();
  // Data SVGs contain nested parentheses, so CSS should be parsed as CSS rather
  // than splitting a url() at its first closing parenthesis.
  const root = postcss.parse(css);
  root.walkDecls(decl => {
    const value = decl.value;
    for (const match of value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
      const url = (match[1] ?? match[2] ?? match[3]).trim();
      if (!url.startsWith('#') && !/^data:(?:image\/|font\/|application\/font)/i.test(url)) invalid();
    }
    if (/expression\s*\(|-moz-binding/i.test(value)) invalid();
  });
}
function moduleScript(code) {
  const key = createHash('sha256').update(code).digest('hex');
  if (moduleCache.has(key)) return moduleCache.get(key);
  // A fixed cap bounds memory if a caller supplies distinct inline modules.
  if (moduleCache.size >= 8) moduleCache.delete(moduleCache.keys().next().value);
  const result = build({
    stdin: { contents: code, resolveDir: HERE, sourcefile: 'lesson-module.js', loader: 'js' },
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2020', minify: true,
    legalComments: 'inline', logLevel: 'silent',
    plugins: [{ name: 'only-pinned-three', setup(api) {
      api.onResolve({ filter: /.*/ }, args => {
        if (args.path === 'three') return { path: require.resolve('three') };
        if (['three/addons/controls/OrbitControls.js', 'three/addons/renderers/CSS2DRenderer.js'].includes(args.path)) return { path: require.resolve(args.path) };
        if (args.path.startsWith('.') && args.importer.startsWith(THREE + path.sep)) {
          const resolved = path.resolve(args.resolveDir, args.path);
          if (resolved.startsWith(THREE + path.sep)) return { path: resolved };
        }
        return { errors: [{ text: 'INVALID_PREVIEW_IMPORT' }] };
      });
    } }],
  }).then(result => result.outputFiles[0].text).catch(error => { moduleCache.delete(key); throw error; });
  moduleCache.set(key, result);
  return result;
}
const MATHJAX_SHIM = `(function(){
  const options={delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false},{left:'\\\\(',right:'\\\\)',display:false},{left:'\\\\[',right:'\\\\]',display:true}],throwOnError:false,trust:false,strict:'ignore'};
  const typesetPromise=(roots)=>Promise.resolve().then(()=>{for(const root of roots||[document.body])if(root)renderMathInElement(root,options);});
  window.MathJax={typesetPromise,typesetClear(){},startup:{defaultPageReady:()=>typesetPromise()}};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>typesetPromise());else typesetPromise();
})();`;
const KATEX_CDN = /^https:\/\/cdn\.jsdelivr\.net\/npm\/katex@0\.16\.(?:8|9)\/dist\/(katex\.min\.(?:js|css)|contrib\/auto-render\.min\.js)$/;
const LOCAL_KATEX = /^file:\/\/[^\r\n]*\/node_modules\/katex\/dist\/(katex\.min\.(?:js|css)|contrib\/auto-render\.min\.js)$/;
const OPTIONAL_FONT = /^file:\/\/[^\r\n]*\/node_modules\/(?:lxgw-wenkai-webfont\/style\.css|@fontsource\/(?:noto-serif-sc\/(?:400|600)|noto-sans-sc\/400|zcool-kuaile\/400|jetbrains-mono\/400)\.css)$/;

function audioEmbedder(jobDir) {
  const cache = new Map();
  let total = 0;
  return async value => {
    if (!jobDir) invalid();
    const dir = path.resolve(jobDir);
    let filename;
    try {
      if (value.startsWith('file:')) filename = fileURLToPath(value);
      else if (path.isAbsolute(value)) filename = value;
      else if (/^(?:\.\/)?(?:audio|mix|speech-\d+)\.wav$/.test(value)) filename = path.resolve(dir, value);
      else invalid();
    } catch { invalid(); }
    if (path.dirname(filename) !== dir || !/^(?:audio|mix|speech-\d+)\.wav$/.test(path.basename(filename))) invalid();
    if (!cache.has(filename)) cache.set(filename, (async () => {
      const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size < 12 || stat.size > MAX_AUDIO || total + stat.size > MAX_AUDIO) tooLarge();
        total += stat.size;
        // Bound the actual read as well as stat(): a concurrently growing file
        // must not turn readFile() into an unbounded allocation.
        const buffer = Buffer.alloc(stat.size + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        if (offset !== stat.size) invalid();
        const data = buffer.subarray(0, offset);
        if (data.subarray(0, 4).toString() !== 'RIFF' || data.subarray(8, 12).toString() !== 'WAVE') invalid();
        return `data:audio/wav;base64,${data.toString('base64')}`;
      } finally { await handle.close(); }
    })());
    return cache.get(filename);
  };
}
async function replaceAudioStrings(code, embed) {
  const matches = [...code.matchAll(/(["'`])([^"'`\\\r\n]*\.wav)\1/g)];
  for (const match of matches.reverse()) {
    const data = await embed(match[2]);
    code = code.slice(0, match.index) + match[1] + data + match[1] + code.slice(match.index + match[0].length);
    if (Buffer.byteLength(code) > MAX_HTML) tooLarge();
  }
  return code;
}
function checkScript(code) {
  // Trusted library runtimes are inserted after this check. Original lesson
  // code has no network loader. Block literal URLs and fetch-like APIs, while
  // retaining SVG namespace literals used by the math engine.
  for (const match of code.matchAll(/(["'`])((?:https?:|file:|\/\/)[^"'`\r\n]*)\1/gi)) {
    if (!['http://www.w3.org/2000/svg', 'http://www.w3.org/1998/Math/MathML', 'http://www.w3.org/1999/xlink'].includes(match[2])) invalid();
  }
  if (/\b(?:fetch|importScripts|WebSocket|EventSource|XMLHttpRequest)\s*(?:\(|\b)/.test(code) || /\bimport\s*\(/.test(code) || /\bnew\s+(?:Worker|SharedWorker)\b/.test(code)) invalid();
  for (const match of code.matchAll(/\.(?:src|href)\s*=\s*(["'`])([^"'`]+)\1/g)) {
    if (!/^(?:data:|#)/i.test(match[2])) invalid();
  }
}
const csp = kind => `default-src 'none'; script-src 'unsafe-inline'${['analytic-geometry', 'math-video'].includes(kind) ? " 'unsafe-eval'" : ''}; style-src 'unsafe-inline'; img-src data:; media-src data:; font-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;

/** Inline the six trusted tutor formats. This never downloads URLs from HTML.
 * Unknown dependency URLs fail closed. jobDir may expose only bounded WAV files.
 */
export async function makeStandalonePreview(html, { kind, jobDir } = {}) {
  if (typeof html !== 'string' || !KINDS.has(kind)) invalid();
  if (Buffer.byteLength(html) > MAX_HTML) tooLarge();
  // Keep the upstream overflow measurement and drag-to-scroll behavior when
  // the safe compatibility renderer supplies KaTeX display blocks.
  if (kind === 'solid-geometry') html = html.replaceAll('mjx-container[display="true"]', '.katex-display');
  const document = parse(html), embed = audioEmbedder(jobDir);
  let wantsKatexCss = false;
  async function walk(parent) {
    for (const node of [...(parent.childNodes || [])]) {
      const tag = node.tagName;
      if (['base', 'iframe', 'object', 'embed', 'frame', 'frameset'].includes(tag)) invalid();
      if (tag === 'meta' && attr(node, 'http-equiv')) {
        if (/^content-security-policy$/i.test(attr(node, 'http-equiv'))) { replaceNode(node, ''); continue; }
        invalid();
      }
      if (tag === 'script') {
        const type = attr(node, 'type'), url = attr(node, 'src');
        if (type === 'importmap') {
          if (kind !== 'solid-geometry') invalid();
          const map = JSON.parse(source(node));
          if (JSON.stringify(map) !== JSON.stringify({ imports: { three: 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.js', 'three/addons/': 'https://unpkg.com/three@0.160.0/examples/jsm/' } })) invalid();
          replaceNode(node, ''); continue;
        }
        if (url) {
          const katex = KATEX_CDN.exec(url) || LOCAL_KATEX.exec(url);
          if (katex && katex[1] !== 'katex.min.css') {
            wantsKatexCss = true;
            replaceNode(node, inline(await katexScript(katex[1].startsWith('contrib/')), 'katex'));
          } else if (url === 'https://cdn.tailwindcss.com') {
            replaceNode(node, style(await localTailwind(kind)));
          } else if (kind === 'chem-reaction' && url === 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js') {
            replaceNode(node, inline(await readLibrary(path.join(LEGACY, 'three.min.js')), 'three-0.128.0'));
          } else if (kind === 'chem-reaction' && url === 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js') {
            replaceNode(node, inline(await readLibrary(path.join(LEGACY, '../examples/js/controls/OrbitControls.js')), 'orbitcontrols-0.128.0'));
          } else if (kind === 'solid-geometry' && url === 'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js') {
            wantsKatexCss = true;
            replaceNode(node, inline(await katexScript(), 'katex') + inline(await katexScript(true), 'katex-auto-render') + inline(MATHJAX_SHIM, 'mathjax-compat'));
          } else invalid();
          continue;
        }
        const code = await replaceAudioStrings(source(node), embed);
        checkScript(code);
        if (type === 'module') {
          if (kind !== 'solid-geometry') invalid();
          replaceNode(node, inline(await moduleScript(code), 'three-0.160.0-lesson'));
        } else textNode(node, code);
        continue;
      }
      if (tag === 'link') {
        const url = attr(node, 'href') || '';
        const katex = KATEX_CDN.exec(url) || LOCAL_KATEX.exec(url);
        if (attr(node, 'rel') === 'stylesheet' && katex?.[1] === 'katex.min.css') { wantsKatexCss = true; replaceNode(node, ''); }
        else if (attr(node, 'rel') === 'stylesheet' && OPTIONAL_FONT.test(url)) replaceNode(node, '');
        else invalid();
        continue;
      }
      if (tag === 'style') checkCss(source(node));
      for (const attribute of node.attrs || []) {
        const name = attribute.name, value = attribute.value;
        if (['srcset', 'ping', 'action', 'formaction', 'srcdoc', 'manifest', 'background'].includes(name)) invalid();
        if (name === 'style') checkCss(`x{${value}}`);
        if (['src', 'href', 'poster', 'data'].includes(name)) {
          if (!value || value.startsWith('#')) continue;
          if (['audio', 'source'].includes(tag) && name === 'src' && !value.startsWith('data:')) attribute.value = await embed(value);
          else if (!/^data:(?:image\/|audio\/|video\/|font\/)/i.test(value)) invalid();
        }
      }
      await walk(node);
    }
  }
  await walk(document);
  const head = document.childNodes.find(n => n.tagName === 'html')?.childNodes.find(n => n.tagName === 'head');
  if (!head) invalid();
  const additions = parseFragment(`<meta http-equiv="Content-Security-Policy" content="${csp(kind)}">${wantsKatexCss ? style(await katexCss()) : ''}<style>body{font-family:system-ui,"Noto Sans CJK SC","Microsoft YaHei",sans-serif}</style>`).childNodes;
  for (const addition of additions) addition.parentNode = head;
  // CSP precedes every script and resource, including the inlined dependencies.
  head.childNodes.unshift(...additions);
  const output = serialize(document);
  if (Buffer.byteLength(output) > MAX_HTML) tooLarge();
  return output;
}
