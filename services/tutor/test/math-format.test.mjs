import test from 'node:test';
import assert from 'node:assert/strict';
import katex from 'katex';
import {parseFragment} from 'parse5';
import {formatMath} from '../../../apps/web/math-format.mjs';

const format=(text,options={})=>formatMath(text,{...options,renderer:katex});
const nodes=node=>[node,...(node.childNodes||[]).flatMap(nodes)];
const attr=(node,key)=>node.attrs?.find(attribute=>attribute.name===key)?.value;
const maths=html=>nodes(parseFragment(html)).filter(node=>(attr(node,'class')||'').split(' ').includes('katex'));

test('parent answers render exact solver fractions without dollar delimiters',()=>{
  const solid=format('\\frac{2 \\sqrt{22}}{11}',{answer:true}),analytic=format('[-3,\\ \\frac{7}{4}]',{answer:true});
  assert.equal(maths(solid).length,1);assert.equal(maths(analytic).length,1);
  assert.match(solid,/<mfrac>/);assert.match(solid,/<msqrt>/);
  assert.match(analytic,/<mfrac>/);assert.doesNotMatch(solid,/katex-error/);assert.doesNotMatch(analytic,/katex-error/);
  assert.equal(format('x = 4',{answer:true}),'x = 4');
});

test('mixed prose supports all four inline and display delimiter pairs',()=>{
  const html=format('先算 $x=4$，再算 $$\\frac{7}{4}$$；检查 \\(a^2+b^2=c^2\\) 与 \\[\\sqrt{2}\\]。');
  assert.equal(maths(html).length,4);
  assert.equal((html.match(/class="math-formula math-inline"/g)||[]).length,2);
  assert.equal((html.match(/class="math-formula math-block"/g)||[]).length,2);
  assert.match(html,/先算 /);assert.match(html,/；检查 /);assert.match(html,/。$/);
});

test('metadata HTML stays text even beside valid mathematical markup',()=>{
  const html=format('<img src=x onerror="alert(1)">答案 $x<2$ <script>alert(2)</script> & \"quoted\"');
  const elements=nodes(parseFragment(html));
  assert.equal(elements.filter(node=>['script','img','iframe'].includes(node.tagName)).length,0);
  assert.ok(elements.every(node=>!(node.attrs||[]).some(attribute=>attribute.name.startsWith('on'))));
  assert.match(html,/&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);assert.match(html,/&lt;script&gt;/);assert.match(html,/&amp; &quot;quoted&quot;/);assert.equal(maths(html).length,1);
});

test('KaTeX trust stays disabled for links, HTML classes and embedded images',()=>{
  for(const input of ['$\\href{javascript:alert(1)}{click}$','$\\htmlClass{injected}{x}$','$\\includegraphics{https://example.test/tracker.png}$']){
    const html=format(input),elements=nodes(parseFragment(html));
    assert.equal(elements.filter(node=>['a','img','script','iframe'].includes(node.tagName)).length,0,input);
    assert.ok(elements.every(node=>!(attr(node,'class')||'').split(' ').includes('injected')));
    assert.ok(elements.every(node=>!(node.attrs||[]).some(attribute=>['href','src','onerror'].includes(attribute.name))));
  }
});

test('unmatched delimiters, escaped dollars and broken formulas remain safe',()=>{
  assert.equal(format('保留 $x 和 \\(y'),'保留 $x 和 \\(y');
  assert.equal(format('价格 \\$5，& <b>折扣</b>'),'价格 \\$5，&amp; &lt;b&gt;折扣&lt;/b&gt;');
  assert.doesNotThrow(()=>format('$\\frac{1}{$'));
  const invalid=format('$\\frac{<script>}{x}$');assert.equal(nodes(parseFragment(invalid)).filter(node=>node.tagName==='script').length,0);
  assert.equal(formatMath('$x<2$ <img>',{renderer:null}),'$x&lt;2$ &lt;img&gt;');
});

test('formula expansion limits, strict mode and macros are isolated per formula',()=>{
  const seen=[];
  formatMath('$x$ and $y$',{renderer:{renderToString(text,options){seen.push({text,options});return katex.renderToString(text,options);}}});
  assert.equal(seen.length,2);
  for(const {options}of seen){assert.equal(options.trust,false);assert.equal(options.throwOnError,false);assert.equal(options.strict,'ignore');assert.equal(options.maxExpand,1000);assert.equal(options.maxSize,10);}
  assert.notEqual(seen[0].options.macros,seen[1].options.macros);
  assert.equal(formatMath('<b>$x$</b>',{renderer:{renderToString(){throw new Error('unavailable');}}}),'&lt;b&gt;$x$&lt;/b&gt;');
});
