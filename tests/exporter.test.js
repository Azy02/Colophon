import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { initSanitizer } from '../src/js/sanitize.js';
import { buildStandaloneHtml, renderForExport, exportWordCopy, parseSvgDataUri } from '../src/js/exporter.js';

const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

function withDom() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.DOMParser = dom.window.DOMParser;
  initSanitizer(dom.window);
  return dom;
}

test('buildStandaloneHtml is self-contained, script-free, and carries the exact CSP', () => {
  withDom();
  const html = buildStandaloneHtml({
    title: 'My <Doc> "T"',
    bodyHtml: '<p>hello world</p>',
    themeClass: 'theme-light',
    styleClass: 'style-clean',
  });
  assert.ok(html.includes(
    '<meta http-equiv="Content-Security-Policy" ' +
    "content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:\">"),
    'exact CSP meta present');
  assert.ok(!/<script/i.test(html), 'no <script> in export');
  assert.ok(/katex/i.test(html), 'includes katex css marker');
  assert.ok(html.includes('theme-light') && html.includes('style-clean'), 'carries theme + style classes');
  assert.ok(html.includes('&lt;Doc&gt;') && html.includes('&quot;'), 'title is HTML-escaped');
});

test('buildStandaloneHtml re-sanitizes the body (defense in depth)', () => {
  withDom();
  const html = buildStandaloneHtml({
    title: 'x',
    bodyHtml: '<p>ok <img src=x onerror=alert(1)><a href="javascript:evil()">bad</a></p>',
    themeClass: 'theme-light',
    styleClass: 'style-clean',
  });
  assert.ok(!/onerror/i.test(html), 'event handler stripped');
  assert.ok(!/javascript:/i.test(html), 'javascript: URL stripped');
  assert.ok(html.includes('ok'), 'benign text kept');
});

test('renderForExport builds the shared export DOM (math intact, images resolved)', async () => {
  withDom();
  const ctx = {
    getSource: () => '# Title\n\ninline $a^2$ and\n\n$$b = c$$\n\n![x](' + PNG_1x1 + ')\n',
    renderOpts: () => ({}),
    currentName: () => 'doc.md',
    themeClass: () => 'theme-light',
    styleClass: () => 'style-clean',
  };
  const { container, meta, outline } = await renderForExport(ctx);
  assert.ok(container.querySelector('.eq[data-tex]'), 'display equation carries data-tex');
  assert.ok(container.querySelector('.imath[data-tex]'), 'inline math carries data-tex');
  assert.ok(!container.querySelector('img[src^="colophon-asset:"]'), 'no unresolved colophon-asset images');
  assert.ok(container.querySelector('img[src^="data:image/png"]'), 'data-URI image survives');
  assert.equal(typeof meta, 'object');
  assert.ok(Array.isArray(outline));
});

test('exportWordCopy puts Word-targeted HTML on the clipboard: bare MathML, no annotation, styles inlined', async () => {
  withDom();
  // Copy-for-Word never touches docx.js or mathml2omml — it hands Word/Pages/Docs
  // raw <math> MathML on the HTML clipboard and lets their own paste-time
  // converter build the native equation, so the two docx.js/mathml2omml bugs
  // fixed in wordexport.js (see tests/wordexport.test.js) don't apply here. This
  // test's job is just to lock down that this independent path stays correct.
  let captured = null;
  // Node's built-in global `navigator` is a getter-only accessor; redefine it.
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, value: { clipboard: { write: async (items) => { captured = items; } } },
  });
  globalThis.ClipboardItem = class { constructor(parts) { this.parts = parts; } };
  const ctx = {
    getSource: () => '# Title\n\ninline $a^2+b^2=c^2$ math and\n\n$$ \\int_0^\\infty e^{-x^2}\\,dx $$\n\n> [!NOTE]\n> a callout\n',
    renderOpts: () => ({}),
    currentName: () => 'doc.md',
    themeClass: () => 'theme-light',
    styleClass: () => 'style-clean',
  };
  await exportWordCopy(ctx);
  assert.ok(captured, 'clipboard.write was called');
  const html = await captured[0].parts['text/html'].text();
  assert.ok(/<math[ >]/.test(html), 'bare MathML <math> element present');
  assert.ok(!html.includes('<annotation'), 'no <annotation> (would trip a Word warning)');
  assert.ok(!html.includes('undefined'), 'no stray "undefined" text leaked into the clipboard HTML');
  assert.ok(/border-left:4px solid/.test(html), 'callout styling inlined (Word ignores CSS classes)');
});

/* Finalization-sweep regression (2026-07-12): the pre-sanitize href promotion
   was silently UNDONE by buildStandaloneHtml's own re-sanitize (the gate
   re-stashed every promoted relative link) — exported HTML never actually
   carried live project links. Promotion now happens inside, after the gate. */
test('allowLocalRefs promotes vetted relative links AFTER the re-sanitize; traversal never survives', () => {
  const dom = new JSDOM('<!doctype html><body>');
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  initSanitizer(dom.window);
  const body = '<p><a data-local-href="refs/paper.pdf">paper</a>'
    + '<a href="../../etc/hosts">evil-live</a>'
    + '<a data-local-href="../../etc/hosts">evil-stash</a></p>';
  const html = buildStandaloneHtml({ title: 't', bodyHtml: body, allowLocalRefs: true });
  assert.match(html, /<a href="refs\/paper\.pdf">/, 'vetted relative link goes live');
  assert.doesNotMatch(html, /href="\.\.\//, 'no traversal href in the artifact');
  assert.doesNotMatch(html, /data-local-href/, 'no stash left behind');
  // without the flag the stash stays inert (in-app semantics)
  const html2 = buildStandaloneHtml({ title: 't', bodyHtml: body });
  assert.doesNotMatch(html2, /[^-]href="refs\/paper\.pdf"/, 'no live promotion without the flag');
});

/* SVG figures in the Word paths (2026-07-12): an .svg asset resolves to an SVG
   data URI, which Word can't host — the raster pass converts it to PNG like
   mermaid. The canvas half is browser-only; the decode half is pure. */
test('parseSvgDataUri: base64 and URI-encoded payloads decode; non-SVG sources are rejected', () => {
  const xml = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
  assert.equal(parseSvgDataUri('data:image/svg+xml;base64,' + Buffer.from(xml).toString('base64')), xml);
  assert.equal(parseSvgDataUri('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml)), xml);
  assert.equal(parseSvgDataUri('data:image/png;base64,iVBORw0KGgo='), null, 'PNG is not touched');
  assert.equal(parseSvgDataUri('https://example.com/x.svg'), null, 'remote URLs are not touched');
  assert.equal(parseSvgDataUri('data:image/svg+xml;base64,!!!not-base64!!!'), null, 'bad base64 degrades to null');
});
