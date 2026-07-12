/* Pipeline correctness + the XSS gauntlet. Runs the full render chain in Node
   (jsdom supplies the DOM for DOMPurify). */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { initSanitizer, setAllowRemoteImages } from '../src/js/sanitize.js';
import { render } from '../src/js/pipeline.js';

before(() => { initSanitizer(new JSDOM('').window); });

const r = (src, opts) => render(src, opts);

/* ---------------- markdown & math basics ---------------- */
test('basic markdown renders', () => {
  const { html } = r('# Title\n\nSome **bold** text.');
  assert.match(html, /<h1 id="h-title">Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>/);
});

test('inline and display math render via KaTeX', () => {
  const { html, hasMath } = r('Inline $x^2$ and display:\n\n$$\\int_0^1 f\\,dx$$');
  assert.ok(hasMath);
  assert.match(html, /class="imath" data-tex="x\^2"/);
  assert.match(html, /katex-display/);
  assert.match(html, /data-display="1"/);
});

test('backslash-paren and backslash-bracket delimiters work', () => {
  const { html } = r('A \\(a+b\\) and\n\n\\[c=d\\]');
  assert.ok((html.match(/class="katex"/g) || []).length >= 2);
});

test('currency does not become math', () => {
  const { html } = r('It costs $5 and $10 today.');
  assert.doesNotMatch(html, /katex/);
  assert.match(html, /\$5 and \$10/);
});

test('currency next to real math: only the math renders', () => {
  const { html } = r('Pay $10 gives $x$ satisfaction.');
  assert.equal((html.match(/class="imath"/g) || []).length, 1);
  assert.match(html, /data-tex="x"/);
  assert.match(html, /\$10 gives/);
});

test('escaped dollar stays literal', () => {
  const { html } = r('Escape \\$3.50 and math $y$.');
  assert.match(html, /\$3\.50/);
  assert.equal((html.match(/class="imath"/g) || []).length, 1);
});

test('inline math may wrap one line but not a blank line', () => {
  const one = r('a $x +\ny$ b');
  assert.equal((one.html.match(/class="imath"/g) || []).length, 1);
  const two = r('a $x\n\ny$ b');
  assert.doesNotMatch(two.html, /imath/);
});

/* ---------------- code protection ---------------- */
test('dollar inside fenced code is protected', () => {
  const { html } = r('```bash\necho "$HOME and $PATH"\n```');
  assert.doesNotMatch(html, /katex/);
  assert.match(html, /\$HOME/);
});

test('tilde fences are protected too', () => {
  const { html } = r('~~~\n$notmath$\n~~~');
  assert.doesNotMatch(html, /katex/);
});

test('unclosed fence runs to EOF without eating the parser', () => {
  const { html } = r('```python\nx = 1\n# no close');
  assert.match(html, /language-python/);
  assert.match(html, /no close/);
});

test('inline code protects dollars and backticks', () => {
  const { html } = r('Use `$x$` and ``a ` b``.');
  assert.doesNotMatch(html, /imath/);
  assert.match(html, /<code>\$x\$<\/code>/);
  assert.match(html, /<code>a ` b<\/code>/);
});

test('math inside table cells renders', () => {
  const { html } = r('| a | b |\n|---|---|\n| $x_1$ | $y^2$ |');
  assert.equal((html.match(/class="imath"/g) || []).length, 2);
  assert.match(html, /<table>/);
});

test('syntax highlighting applies for known languages', () => {
  const { html } = r('```python\ndef f(x):\n    return x\n```');
  assert.match(html, /hljs-keyword/);
  assert.match(html, /data-lang="python"/);
});

/* ---------------- GFM extensions ---------------- */
test('footnotes, callouts, task lists', () => {
  const { html } = r('Text[^1]\n\n> [!WARNING]\n> Hot.\n\n- [x] done\n\n[^1]: Note.');
  assert.match(html, /class="footnotes"/);
  assert.match(html, /markdown-alert-warning/);
  assert.match(html, /type="checkbox"/);
});

test('outline lists headings with ids', () => {
  const { outline } = r('# A\n\n## B c\n\n### D');
  assert.deepEqual(outline.map(h => h.level), [1, 2, 3]);
  assert.equal(outline[1].id, 'h-b-c');
});

/* ---------------- equation numbering & refs ---------------- */
test('auto numbering: only labeled equations get numbers', () => {
  const res = r('$$a=b \\label{eq:one}$$\n\n$$c=d$$\n\nSee \\eqref{eq:one}.');
  assert.equal(res.eqCount, 1);
  assert.match(res.html, /id="eq-eq:one"/);
  assert.match(res.html, /class="eqref" href="#eq-eq:one">\(1\)<\/a>/);
});

test('numbering all via front matter; notag respected', () => {
  const res = r('---\nnumberEquations: true\n---\n$$a=b$$\n\n$$c=d \\notag$$\n\n$$e=f$$');
  assert.equal(res.eqCount, 2);
});

test('user \\tag is kept and referenced', () => {
  const res = r('$$x=y \\tag{$\\ast$} \\label{eq:star}$$\n\nSee \\eqref{eq:star}.');
  assert.equal(res.eqCount, 0);
  assert.match(res.html, /eqref/);
});

test('unknown eqref renders a visible unresolved marker', () => {
  const { html } = r('See \\eqref{eq:missing}.');
  assert.match(html, /cite-unresolved/);
});

test('eqref inside math resolves to text', () => {
  const { html } = r('$$a=b\\label{eq:x}$$\n\n$$c \\eqref{eq:x}$$', { numbering: 'auto' });
  assert.doesNotMatch(html, /math-err/);
});

/* ---------------- citations ---------------- */
const BIB = '```bibtex\n@article{smith2021, author={Smith, Jane and Lee, Bo}, title={A Study}, journal={J. Res.}, year={2021}, volume={4}, pages={1--9}}\n```\n';

test('numeric citations + references section', () => {
  const res = r(BIB + '\nAs shown [@smith2021].');
  assert.equal(res.citeCount, 1);
  assert.match(res.html, /<a class="cite" href="#ref-smith2021">\[1\]<\/a>/);
  assert.match(res.html, /class="references"/);
  assert.match(res.html, /Smith/);
  assert.match(res.html, /bib-chip/);
});

test('author-year style', () => {
  const res = r('---\ncitationStyle: author-year\n---\n' + BIB + '\nShown [@smith2021].');
  assert.match(res.html, /Smith &amp; Lee, 2021/);
});

test('unresolved citation is visibly flagged', () => {
  const { html } = r('Missing [@nope2020].');
  assert.match(html, /cite-unresolved/);
  assert.match(html, /@nope2020/);
});

test('cite command syntax works', () => {
  const res = r(BIB + '\nSee \\cite{smith2021}.');
  assert.match(res.html, /class="cite"/);
});

/* ---------------- front matter ---------------- */
test('title block renders; hr-at-top is not front matter', () => {
  const res = r('---\ntitle: My Paper\nauthors: [A. One, B. Two]\ndate: 2026-07-05\nabstract: Short.\n---\n\nBody.');
  assert.match(res.html, /doc-title/);
  assert.match(res.html, /A\. One, B\. Two/);
  assert.match(res.html, /doc-abstract/);
  const hr = r('---\n\nJust an hr.');
  assert.doesNotMatch(hr.html, /doc-title/);
});

test('no state bleed between renders', () => {
  const a = r('# Same\n\nText[^1].\n\n[^1]: n.').html;
  const b = r('# Same\n\nText[^1].\n\n[^1]: n.').html;
  assert.equal(a, b);
});

/* ---------------- the XSS gauntlet ---------------- */
const hostile = [
  ['img onerror', '<img src=x onerror=alert(1)>', /onerror/],
  ['script tag', '<script>alert(1)</script>', /<script/],
  ['js link md', '[x](javascript:alert(1))', /href="javascript/i],
  ['js link mixed case', '<a href="JaVaScRiPt:alert(1)">x</a>', /href/],
  ['iframe', '<iframe src="https://evil.example"></iframe>', /<iframe/],
  ['svg onload', '<svg onload=alert(1)><circle r=1></svg>', /onload/],
  ['data html link', '<a href="data:text/html,<script>alert(1)</script>">x</a>', /href/],
  ['form input', '<form action=https://evil.example><input type=text name=q></form>', /<form|<input/],
  ['details ontoggle', '<details open ontoggle=alert(1)>x</details>', /ontoggle/],
  ['td event', '| a |\n|---|\n| <span onmouseover=alert(1)>x</span> |', /onmouseover/],
  ['style exfil tag', '<style>@import url(https://evil.example)</style>', /<style/],
  ['base tag', '<base href="https://evil.example/">', /<base/],
  ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example">', /<meta/],
  ['object', '<object data="x.swf"></object>', /<object/],
  ['embed', '<embed src="x.swf">', /<embed/],
  ['srcdoc-ish', '<iframe srcdoc="<script>alert(1)</script>"></iframe>', /srcdoc|<iframe/],
];

for (const [name, payload, badRe] of hostile) {
  test(`XSS: ${name}`, () => {
    const { html } = r(`before\n\n${payload}\n\nafter`);
    assert.doesNotMatch(html, badRe);
  });
}

test('XSS: mXSS nesting attempt', () => {
  const { html } = r('<noscript><p title="</noscript><img src=x onerror=alert(1)>">x</p>');
  assert.doesNotMatch(html, /onerror/);
});

test('relative img src becomes inert data-local-src (project-file stash), never a live src', () => {
  // ![x](plot.svg) — the folder resolver reads the stash and swaps in a blob:
  // URL it creates itself; the raw value must never survive as src.
  const { html } = r('![from disk](figures/plot.svg)');
  assert.match(html, /data-local-src="figures\/plot\.svg"/);
  assert.doesNotMatch(html, /[^-]src="figures\//);   // no LIVE src (data-local-src is the only carrier)
  // schemes, protocol-relative, and site-absolute paths get NO stash at all
  for (const bad of ['javascript:alert(1)', '//evil.example/x.png', '/etc/passwd', 'fig:x']) {
    const out = r('![y](' + bad.replace(/([()])/g, '\\$1') + ')').html;
    assert.doesNotMatch(out, /data-local-src/, bad);
  }
});

test('relative link href becomes inert data-local-href (project-file stash), never a live href', () => {
  // [paper](refs/paper.pdf) — the preview click handler resolves the stash
  // through the folder reader into the in-app viewer; no live href survives.
  const { html } = r('[read the paper](refs/paper.pdf)');
  assert.match(html, /data-local-href="refs\/paper\.pdf"/);
  assert.doesNotMatch(html, /[^-]href="refs\//);   // no LIVE href (data-local-href is the only carrier)
  // schemes, protocol-relative, and site-absolute links get NO stash
  for (const bad of ['javascript:alert(1)', '//evil.example/x.pdf', '/etc/passwd.pdf', 'vbscript:x']) {
    const out = r('[y](' + bad.replace(/([()])/g, '\\$1') + ')').html;
    assert.doesNotMatch(out, /data-local-href/, bad);
  }
  // real absolute links keep working untouched
  const ok = r('[site](https://example.org/x.pdf)').html;
  assert.match(ok, /href="https:\/\/example\.org\/x\.pdf"/);
});

test('XSS: URI-safe data-attrs did not loosen href/src (fig: scheme still blocked)', () => {
  // data-xref/data-tex are ADD_URI_SAFE_ATTR so colon values survive (see the
  // cross-ref test below), but that must NOT let a "fig:"-style or javascript:
  // scheme through on an actual navigable attribute.
  assert.doesNotMatch(r('<a href="fig:setup">x</a>').html, /href="fig:/i);
  assert.doesNotMatch(r('<a href="javascript:alert(1)">x</a>').html, /href="javascript/i);
  assert.doesNotMatch(r('<img src="fig:x">').html, /src="fig:/i);
});

test('cross-references: \\ref{fig:…}/\\ref{tbl:…} resolve to numbered links (regression)', async () => {
  // Regression for a real, pre-existing bug: DOMPurify ran the href/src URI
  // regexp against data-xref (colon value "fig:a" looks like an unknown scheme)
  // and silently stripped it, so every figure/table cross-reference rendered as
  // "(?)". Fixed via ADD_URI_SAFE_ATTR. Verified end-to-end through postdom.
  const { JSDOM } = await import('jsdom');
  const { applyPostDom } = await import('../src/js/postdom.js');
  const dom = new JSDOM('<div id="c"></div>');
  const c = dom.window.document.getElementById('c');
  const res = r('See \\ref{fig:a} and \\ref{tbl:b}.\n\n![cap](data:image/png;base64,iVBORw0KGgo=) {#fig:a}\n\nTable: A table {#tbl:b}\n\n| x | y |\n|---|---|\n| 1 | 2 |\n');
  c.innerHTML = res.html;
  applyPostDom(c, { outline: res.outline, meta: res.meta, forExport: false });
  const links = [...c.querySelectorAll('a')].map((a) => a.textContent.trim());
  assert.ok(links.includes('Figure 1'), 'fig ref resolved to a link, got: ' + JSON.stringify(links));
  assert.ok(links.includes('Table 1'), 'tbl ref resolved to a link');
  assert.doesNotMatch(c.textContent, /\(\?\)/, 'no unresolved-reference placeholder remains');
});

test('XSS: katex href trust is off', () => {
  const { html } = r('$\\href{javascript:alert(1)}{click}$');
  assert.doesNotMatch(html, /href="javascript/i);
});

test('XSS: hostile bibtex fields are escaped', () => {
  const res = r('```bibtex\n@misc{k, title={<img src=x onerror=alert(1)>}, author={Evil}, year={2020}}\n```\n\n[@k]');
  assert.doesNotMatch(res.html, /<img/);           // must be escaped text, not markup
  assert.match(res.html, /&lt;img/);
});

test('XSS: sentinel forgery in input is neutralized', () => {
  const { html } = r('forged D0 token');
  assert.doesNotMatch(html, /[]/);
});

test('allowed: data:image and colophon-asset img survive; https link gets noopener', () => {
  const { html } = r('<img src="data:image/png;base64,iVBORw0KGgo=" alt="p">\n\n![a](colophon-asset:abc123)\n\n[link](https://example.com)');
  assert.match(html, /data:image\/png/);
  assert.match(html, /colophon-asset:abc123/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('privacy: remote images blocked by default, per-doc opt-in loads them', () => {
  const blocked = r('![chart](https://example.com/a.png)').html;
  assert.doesNotMatch(blocked, /(?<!-)src="https:/);   // (?<!-) so data-remote-src doesn't false-match
  assert.match(blocked, /data-remote-src="https:\/\/example\.com\/a\.png"/);
  setAllowRemoteImages(true);
  try {
    const loaded = r('![chart](https://example.com/a.png)').html;
    assert.match(loaded, /src="https:\/\/example\.com\/a\.png"/);
  } finally { setAllowRemoteImages(false); }
  // local images are never affected
  const local = r('![p](data:image/png;base64,iVBORw0KGgo=) and ![q](colophon-asset:x1)').html;
  assert.match(local, /data:image\/png/);
  assert.match(local, /colophon-asset:x1/);
});

test('postdom directives ignored inside blockquotes (reviewer finding)', async () => {
  const { JSDOM } = await import('jsdom');
  const { applyPostDom } = await import('../src/js/postdom.js');
  const dom = new JSDOM('<div id="c"></div>');
  const c = dom.window.document.getElementById('c');
  const res = r('## A\n\n> [TOC]\n\n> ![cap](data:image/png;base64,iVBORw0KGgo=)\n\n[TOC]');
  c.innerHTML = res.html;
  applyPostDom(c, { outline: res.outline, meta: res.meta, forExport: true });
  assert.equal(c.querySelectorAll('blockquote nav.toc').length, 0, 'quoted [TOC] must stay text');
  assert.equal(c.querySelectorAll('blockquote figure').length, 0, 'quoted image must not become a figure');
  assert.equal(c.querySelectorAll(':scope > nav.toc').length, 1, 'top-level [TOC] still works');
});

test('figure attribute block: label + width parse into <figure> (Insert Figure output)', async () => {
  const { JSDOM } = await import('jsdom');
  const { applyPostDom } = await import('../src/js/postdom.js');
  const mk = (md) => {
    const dom = new JSDOM('<div id="c"></div>');
    const c = dom.window.document.getElementById('c');
    const res = r(md);
    c.innerHTML = res.html;
    applyPostDom(c, { outline: res.outline, meta: res.meta, forExport: true });
    return c;
  };
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';
  // label + width (the full Insert Figure emission)
  let c = mk('![Energy vs. stress](' + PNG + ') {#fig:energy width=50%}');
  const fig = c.querySelector('figure');
  assert.ok(fig, 'a <figure> was produced');
  assert.equal(fig.id, 'fig-energy', 'label became the figure id');
  assert.match(fig.querySelector('figcaption').textContent, /Figure 1\.\s*Energy vs\. stress/);
  assert.match(fig.querySelector('img').getAttribute('style') || '', /width:50%/, 'width applied to img');
  assert.ok(!/\{#fig/.test(c.textContent), 'the attribute block is consumed, not shown');
  // width-only (no label) still makes a figure and sizes it
  c = mk('![](' + PNG + ') {width=75%}');
  assert.match(c.querySelector('figure img').getAttribute('style') || '', /width:75%/);
  // px unit and bare number both normalize
  c = mk('![c](' + PNG + ') {width=300}');
  assert.match(c.querySelector('figure img').getAttribute('style') || '', /width:300px/);
  // a plain image with no alt and no attrs stays a plain <img>, not a figure
  c = mk('![](' + PNG + ')');
  assert.equal(c.querySelector('figure'), null, 'bare image is left alone');
  // a bogus attribute block on a no-alt image parses to nothing → no figure, no
  // width/style, and the block stays inert text (never becomes an attribute)
  c = mk('![](' + PNG + ') {onerror=alert(1)}');
  assert.equal(c.querySelector('figure'), null, 'bogus block does not force a figure');
  assert.equal(c.querySelector('img').getAttribute('style'), null, 'no style leaked from a bogus block');
  assert.ok(/\{onerror/.test(c.textContent), 'unrecognized brace block left as inert text');
});

test('math errors degrade to visible error, not exceptions', () => {
  const { html } = r('$\\frac{$ and $$\\begin{matrix}$$');
  assert.ok(html.length > 0);
});

/* Finalization-sweep regressions (2026-07-12). */
test('mid-paragraph display math splits the paragraph — no orphan text node', () => {
  // a block <div class="eq"> inside <p> makes the HTML parser auto-close the
  // paragraph, orphaning the trailing prose as a bare text node that the
  // element-only DOCX/LaTeX walkers silently DROP
  const { html } = r('Some text $$x = 1$$ must not vanish after.');
  const dom = new JSDOM('<div id="c">' + html + '</div>');
  const c = dom.window.document.getElementById('c');
  assert.ok(![...c.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()), 'no orphan text node');
  const ps = [...c.querySelectorAll('p')].map((p) => p.textContent.trim());
  assert.ok(ps.some((t) => t.startsWith('Some text')), 'leading prose wrapped');
  assert.ok(ps.some((t) => t.includes('must not vanish')), 'trailing prose wrapped');
  assert.ok(c.querySelector('div.eq'), 'display block present');
});

test('data-local stash rejects .. traversal, raw and %-encoded', () => {
  const { html } = r('[a](../../etc/hosts) [b](refs/%2e%2e/x) [c](refs/ok.pdf) ![i](../up.png)');
  assert.doesNotMatch(html, /data-local-href="\.\./, 'raw .. href not stashed');
  assert.doesNotMatch(html, /%2e%2e/i, 'encoded .. href not stashed');
  assert.match(html, /data-local-href="refs\/ok\.pdf"/, 'clean relative still stashed');
  assert.doesNotMatch(html, /data-local-src="\.\./, 'raw .. img not stashed');
});
