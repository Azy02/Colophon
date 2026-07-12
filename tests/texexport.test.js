import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { render } from '../src/js/pipeline.js';
import { applyPostDom } from '../src/js/postdom.js';
import { initSanitizer } from '../src/js/sanitize.js';
import { buildLatex } from '../src/js/texexport.js';

function tex(md, opts = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.DOMParser = dom.window.DOMParser;
  initSanitizer(dom.window);
  const res = render(md, opts);
  const c = dom.window.document.createElement('div');
  c.innerHTML = res.html;
  applyPostDom(c, { outline: res.outline, meta: res.meta, resolveAsset: null, forExport: true });
  return buildLatex(c, res.meta);
}

test('preamble: standalone article, math packages always, hyperref last', () => {
  const { tex: t } = tex('hello');
  assert.match(t, /\\documentclass\[11pt\]\{article\}/);
  assert.match(t, /\\usepackage\{amsmath,amssymb\}/);
  assert.match(t, /\\begin\{document\}[\s\S]*\\end\{document\}/);
  // hyperref loads after amsmath and after any conditional package
  const hyper = t.indexOf('\\usepackage{hyperref}');
  assert.ok(hyper > t.indexOf('amsmath'), 'hyperref after amsmath');
});

test('conditional packages: graphicx only with images, tabular only with tables', () => {
  assert.doesNotMatch(tex('just prose').tex, /graphicx|longtable/);
  assert.match(tex('![c](data:image/png;base64,iVBORw0KGgo=) {#fig:a}').tex, /\\usepackage\{graphicx\}/);
  assert.match(tex('| a | b |\n|---|---|\n| 1 | 2 |').tex, /\\usepackage\{longtable,booktabs,array\}/);
});

test('front matter → title block + maketitle', () => {
  const { tex: t } = tex('---\ntitle: My Paper\nauthor: A. Author\ndate: 2026\n---\n\nBody.');
  assert.match(t, /\\title\{My Paper\}/);
  assert.match(t, /\\author\{A\. Author\}/);
  assert.match(t, /\\maketitle/);
});

test('headings map to section levels', () => {
  const { tex: t } = tex('# One\n\n## Two\n\n### Three');
  assert.match(t, /\\section\{One\}/);
  assert.match(t, /\\subsection\{Two\}/);
  assert.match(t, /\\subsubsection\{Three\}/);
});

test('inline styles and inline math', () => {
  const { tex: t } = tex('Text **bold** *italic* `code` and $a^2+b^2$ math.');
  assert.match(t, /\\textbf\{bold\}/);
  assert.match(t, /\\emph\{italic\}/);
  assert.match(t, /\\texttt\{code\}/);
  assert.match(t, /\$a\^2\+b\^2\$/, 'inline math copied verbatim from data-tex');
});

test('display math: original TeX round-trips, \\tag stripped, label recovered', () => {
  const { tex: t } = tex('$$ E = mc^2 \\label{mass} $$');
  assert.match(t, /\\begin\{equation\}\\label\{eq:mass\}\nE = mc\^2\n\\end\{equation\}/);
  assert.doesNotMatch(t, /\\tag\{/, 'the pipeline-injected \\tag number is not exported');
});

test('cross-reference resolves to \\ref with the recovered label', () => {
  const { tex: t } = tex('See \\ref{fig:a}.\n\n![cap](data:image/png;base64,iVBORw0KGgo=) {#fig:a}');
  assert.match(t, /See \\ref\{fig:a\}\./);
  assert.match(t, /\\label\{fig:a\}/);
});

test('an already-namespaced label is not double-prefixed (\\label{eq:kp}, not eq:eq:kp)', () => {
  // regression: id "eq-eq:kp" must map back to "eq:kp", not "eq:eq:kp"
  const { tex: t } = tex('$$ E = mc^2 \\label{eq:kp} $$\n\nSee \\ref{eq:kp}.');
  assert.match(t, /\\label\{eq:kp\}/);
  assert.doesNotMatch(t, /eq:eq:kp/);
});

test('figure: includegraphics with width fraction, caption without the "Figure N." prefix', () => {
  const { tex: t } = tex('![The setup](data:image/png;base64,iVBORw0KGgo=) {#fig:s width=50%}');
  assert.match(t, /\\begin\{figure\}\[htbp\]/);
  assert.match(t, /\\includegraphics\[width=0\.50\\linewidth\]\{image-1\.png\}/);
  assert.match(t, /\\caption\{The setup\}/);
  assert.doesNotMatch(t, /Figure 1\./, 'the rendered number is not duplicated into the caption');
});

test('lists, blockquote, code fence', () => {
  const { tex: t } = tex('- a\n- b\n\n1. x\n2. y\n\n> quoted\n\n```py\ncode()\n```');
  assert.match(t, /\\begin\{itemize\}[\s\S]*\\item a[\s\S]*\\item b[\s\S]*\\end\{itemize\}/);
  assert.match(t, /\\begin\{enumerate\}[\s\S]*\\item x[\s\S]*\\end\{enumerate\}/);
  assert.match(t, /\\begin\{quote\}\nquoted\n\\end\{quote\}/);
  assert.match(t, /\\begin\{verbatim\}\ncode\(\)\n\\end\{verbatim\}/);
});

test('table → tabular with booktabs rules', () => {
  const { tex: t } = tex('| Metal | a0 |\n|-------|----|\n| W | 3.165 |');
  assert.match(t, /\\begin\{tabular\}\{ll\}/);
  assert.match(t, /\\toprule[\s\S]*Metal & a0 \\\\[\s\S]*\\midrule[\s\S]*W & 3\.165 \\\\[\s\S]*\\bottomrule/);
});

test('citation [@key] → \\cite{key}, and a note flags the missing .bib', () => {
  const { tex: t, notes } = tex('As shown [@dorn64].', { citationStyle: 'numeric' });
  assert.match(t, /\\cite\{dorn64\}/);
  assert.ok(notes.some((n) => /\.bib/.test(n)), 'exports a note about needing a .bib');
});

test('footnote reference → \\footnote{} inline, body pulled from the notes section', () => {
  const { tex: t } = tex('A claim[^1].\n\n[^1]: the evidence');
  assert.match(t, /A claim\\footnote\{the evidence\}\./);
});

test('LaTeX special characters in prose are escaped', () => {
  const { tex: t } = tex('Costs 50% & rises #1 with a_b and c~d and e^f.');
  assert.match(t, /50\\%/);
  assert.match(t, /\\&/);
  assert.match(t, /#1/.source ? /\\#1/ : /\\#/);
  assert.match(t, /a\\_b/);
  assert.match(t, /\\textasciitilde\{\}/);
  assert.match(t, /\\textasciicircum\{\}/);
});

test('escaping never corrupts math or code (they carry their own syntax)', () => {
  const { tex: t } = tex('Math $x_1 \\& y$ and code `a_b%`.');
  assert.match(t, /\$x_1 \\& y\$/, 'math body verbatim, not double-escaped');
  assert.match(t, /\\texttt\{a\\_b\\%\}/, 'code escaped as text (no verbatim inline)');
});

test('links: http → \\href, internal anchors flattened', () => {
  const { tex: t } = tex('See [the site](https://example.org/x) and [top](#h-one).');
  assert.match(t, /\\href\{https:\/\/example\.org\/x\}\{the site\}/);
  assert.match(t, /\btop\b/);
  assert.doesNotMatch(t, /\\href\{#/, 'internal anchor is not an href');
});

test('data-URI images are referenced as image-N.png and flagged in notes', () => {
  const { tex: t, notes } = tex('![a](data:image/png;base64,iVBORw0KGgo=) {#fig:a}\n\n![b](data:image/png;base64,iVBORw0KGgo=) {#fig:b}');
  assert.match(t, /\{image-1\.png\}/);
  assert.match(t, /\{image-2\.png\}/);
  assert.ok(notes.some((n) => /image-N\.png/.test(n)));
});

test('output is a complete, single document (one begin/end, escape-hatch banner present)', () => {
  const { tex: t } = tex('# H\n\ntext');
  assert.equal((t.match(/\\begin\{document\}/g) || []).length, 1);
  assert.equal((t.match(/\\end\{document\}/g) || []).length, 1);
  assert.match(t, /not a submission-ready file/);
});

/* Finalization-sweep regressions (2026-07-12). */
test('footnote bodies render through the inline walker — math and bold survive', () => {
  const { tex: t } = tex('Claim.[^1]\n\n[^1]: The identity $E=mc^2$ is **famous**.');
  assert.match(t, /\\footnote\{The identity \$E=mc\^2\$ is \\textbf\{famous\}\.\}/);
  assert.doesNotMatch(t, /E=mc2E=mc/, 'no tripled KaTeX text-content garbage');
});

test('RESOLVED citations recover their key from the #ref- href', () => {
  const { tex: t } = tex('A claim [@doe2020] here.\n\n```bibtex\n@article{doe2020, title={T}, author={Doe, J.}, year={2020}}\n```');
  assert.match(t, /\\cite\{doe2020\}/);
  assert.doesNotMatch(t, /claim \[1\]/, 'not the baked numeric label');
});

test('unresolved project images keep their real relative path in \\includegraphics', () => {
  const { tex: t } = tex('![plot a](figs/one.png)\n\n![plot b](figs/two.png)');
  assert.match(t, /\\includegraphics\[[^\]]*\]\{figs\/one\.png\}/);
  assert.match(t, /\\includegraphics\[[^\]]*\]\{figs\/two\.png\}/);
});

test('mid-paragraph display math loses no surrounding prose', () => {
  const { tex: t } = tex('Some text $$x = 1$$ must not vanish after.');
  assert.match(t, /Some text/);
  assert.match(t, /must not vanish after\./);
  assert.match(t, /\\begin\{equation/);
});
