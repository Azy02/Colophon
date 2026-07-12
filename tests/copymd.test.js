import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { render } from '../src/js/pipeline.js';
import { applyPostDom } from '../src/js/postdom.js';
import { initSanitizer } from '../src/js/sanitize.js';
import { serializeSelection } from '../src/js/copymd.js';

/* Render markdown to the same postdom preview DOM the app uses, then serialize
   the whole thing (or a sub-element) the way the copy handler would. */
function copyOf(md, selector) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.DOMParser = dom.window.DOMParser;
  initSanitizer(dom.window);
  const res = render(md, {});
  const c = dom.window.document.createElement('div');
  c.innerHTML = res.html;
  applyPostDom(c, { outline: res.outline, meta: res.meta, resolveAsset: null, forExport: false });
  // mimic Range.cloneContents(): selecting an element includes that element;
  // selecting the whole doc includes all top-level children.
  const holder = dom.window.document.createElement('div');
  if (selector) holder.appendChild(c.querySelector(selector).cloneNode(true));
  else for (const n of c.childNodes) holder.appendChild(n.cloneNode(true));
  return serializeSelection(holder);
}

test('inline math copies as $…$ from data-tex, not KaTeX garbage', () => {
  const out = copyOf('The relation $E = mc^2$ holds here.');
  assert.match(out, /The relation \$E = mc\^2\$ holds here\./);
  assert.doesNotMatch(out, /katex|span/i);
});

test('display math copies as $$…$$ with the tag stripped', () => {
  const out = copyOf('$$ F = ma \\label{n} $$');
  assert.match(out, /\$\$\nF = ma\n\$\$/);
  assert.doesNotMatch(out, /\\tag|\\label/);
});

test('a table copies as a GFM pipe table, not run-together cell text', () => {
  const out = copyOf('| Metal | a0 |\n|-------|----|\n| W | 3.165 |\n| Mo | 3.147 |', 'table');
  assert.match(out, /\| Metal \| a0 \|/);
  assert.match(out, /\| --- \| --- \|/);
  assert.match(out, /\| W \| 3\.165 \|/);
  assert.match(out, /\| Mo \| 3\.147 \|/);
});

test('prose formatting flattens to clean text — no stray ** or _ markers', () => {
  const out = copyOf('This has **bold**, *italic*, and a [link](https://x.org) inside.');
  assert.match(out, /This has bold, italic, and a link inside\./);
  assert.doesNotMatch(out, /\*\*|\[link\]|https/);
});

test('inline code flattens to its text (clean), not backtick-wrapped', () => {
  const out = copyOf('Call `np.array(x)` first.');
  assert.match(out, /Call np\.array\(x\) first\./);
  assert.doesNotMatch(out, /`/);
});

test('a fenced code block copies fenced (indentation/newlines matter)', () => {
  const out = copyOf('```python\nx = 1\ny = 2\n```', '.code-wrap');
  assert.match(out, /```python\nx = 1\ny = 2\n```/);
});

test('a mixed prose + math selection: prose clean, math as source', () => {
  const out = copyOf('Given **stress** $\\tau$, velocity is $v_0 e^{-E/kT}$ overall.');
  assert.match(out, /Given stress \$\\tau\$, velocity is \$v_0 e\^\{-E\/kT\}\$ overall\./);
});

test('empty / whitespace selection yields empty string', () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="h"> </div></body></html>');
  const holder = dom.window.document.getElementById('h');
  assert.equal(serializeSelection(holder), '');
});

test('headings and paragraphs are separated by blank lines, not glued', () => {
  const out = copyOf('# Title\n\nFirst para.\n\nSecond para.');
  assert.match(out, /Title\n\nFirst para\.\n\nSecond para\./);
});
