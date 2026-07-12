import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { JSDOM } from 'jsdom';
import { Packer } from 'docx';
import { render } from '../src/js/pipeline.js';
import { applyPostDom } from '../src/js/postdom.js';
import { initSanitizer } from '../src/js/sanitize.js';
import { buildDocx, texToOmml, stripTag } from '../src/js/wordexport.js';

const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

function withDom() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.DOMParser = dom.window.DOMParser;
  initSanitizer(dom.window);
  return dom;
}

const FIXTURE = [
  '---', 'title: Sample Report', 'author: Ada Lovelace', 'date: 2026-07-05', '---', '',
  '# Introduction', '',
  'Some **bold** text and `inline code`, plus inline math $a^2 + b^2 = c^2$ here.', '',
  '$$ E = mc^2 \\label{energy} $$', '',
  '$$ \\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2} $$', '',
  '| Name | Value |', '|------|-------|', '| pi | 3.14 |', '',
  '> [!WARNING]', '> Handle with care.', '',
  '```python', 'import numpy as np', 'print(np.pi)', '```', '',
  'A claim with a footnote[^n].', '',
  '![a tiny image](' + PNG_1x1 + ')', '',
  '[^n]: The footnote body.',
].join('\n');

function buildBufferFromFixture() {
  const dom = withDom();
  const r = render(FIXTURE, { numbering: 'auto' });
  const holder = dom.window.document.createElement('div');
  holder.innerHTML = r.html;
  applyPostDom(holder, { outline: r.outline, meta: r.meta, resolveAsset: null, forExport: true });
  const doc = buildDocx(holder, r.meta);
  return { doc, meta: r.meta, eqCount: r.eqCount };
}

/* Minimal ZIP local-file reader (docx entries are DEFLATE, method 8). */
function inflateEntry(buf, name) {
  const target = Buffer.from(name);
  for (let i = 0; i + 30 < buf.length; i++) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x03 && buf[i + 3] === 0x04) {
      const method = buf.readUInt16LE(i + 8);
      const csize = buf.readUInt32LE(i + 18);
      const nlen = buf.readUInt16LE(i + 26), elen = buf.readUInt16LE(i + 28);
      if (buf.slice(i + 30, i + 30 + nlen).equals(target)) {
        const start = i + 30 + nlen + elen;
        const comp = buf.slice(start, start + csize);
        return method === 8 ? zlib.inflateRawSync(comp) : comp;
      }
    }
  }
  return null;
}

test('texToOmml returns a bare OMmath with no annotation element', () => {
  withDom();
  const inline = texToOmml('a^2 + b^2 = c^2', false);
  assert.ok(typeof inline === 'string');
  assert.ok(inline.includes('<m:oMath'), 'contains <m:oMath');
  assert.ok(!inline.includes('<annotation'), 'no <annotation (would trip a Word warning)');
  const display = texToOmml('\\int_0^1 x\\,dx', true);
  assert.ok(display.includes('<m:oMath') && !display.includes('annotation'));
});

test('regression: mathvariant="normal" (KaTeX\'s upright \\infty etc.) never leaks as m:val="undefined"', () => {
  withDom();
  // mathml2omml@0.5.0 has no 'normal' entry in its variant->m:val table; KaTeX
  // marks upright operators/symbols (like \infty) mathvariant="normal", and
  // unless texToOmml() strips it first, the library emits the literal string
  // "undefined" as the m:val attribute value. Well-formed XML, but a value
  // Word doesn't recognize — part of what made real Word reject exported docs.
  const omml = texToOmml('\\int_0^\\infty e^{-x^2}\\,dx', true);
  assert.ok(omml, 'converts without throwing');
  assert.ok(!omml.includes('"undefined"'), 'no m:val="undefined" leaked from an unmapped mathvariant');
});

test('regression: n-ary operators (\\int/\\sum) carry no empty <m:e/> base (Word placeholder box)', () => {
  withDom();
  // KaTeX MathML puts the operand after <msubsup><mo>∫</mo>…</msubsup> as
  // siblings; mathml2omml@0.5.0 turns that into <m:nary> with an EMPTY <m:e/>
  // base, which real Word renders as a dotted placeholder box in the middle of
  // the integral (verified visually). texToOmml() now moves the trailing
  // operand into the base, stopping at a top-level relation.
  const omml = texToOmml('\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}', true);
  assert.ok(omml.includes('<m:nary'), 'integral produced an n-ary');
  assert.ok(!/<m:e\s*\/>|<m:e\s*><\/m:e>/.test(omml), 'no empty m:e base left behind');
  // the integrand moved INSIDE the n-ary; the "= √π/2" tail stayed outside
  const naryChunk = omml.slice(omml.indexOf('<m:nary'), omml.indexOf('</m:nary>'));
  const naryTexts = [...naryChunk.matchAll(/<m:t[^>]*>([^<]*)<\/m:t>/g)].map((m) => m[1]).join('');
  assert.ok(naryTexts.includes('d'), 'dx landed inside the n-ary base, got: ' + JSON.stringify(naryTexts));
  assert.ok(!naryTexts.includes('='), 'relation stayed outside the n-ary base, got: ' + JSON.stringify(naryTexts));
  // a sum nests the same way
  const sum = texToOmml('\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}', true);
  assert.ok(sum.includes('<m:nary') && !/<m:e\s*\/>|<m:e\s*><\/m:e>/.test(sum), 'sum also repaired');
});

test('stripTag lifts the \\tag number and clears \\label off the TeX', () => {
  assert.deepEqual(stripTag('E = mc^2\\tag{4}'), { tex: 'E = mc^2', number: '4' });
  assert.deepEqual(stripTag('a=b \\label{foo}'), { tex: 'a=b', number: null });
  assert.deepEqual(stripTag('x'), { tex: 'x', number: null });
});

test('buildDocx packs a valid, non-trivial .docx buffer (PK + word/document.xml + >3KB)', async () => {
  const { doc } = buildBufferFromFixture();
  const buf = await Packer.toBuffer(doc);
  assert.ok(buf && buf.length > 3072, 'buffer larger than 3 KB, got ' + (buf && buf.length));
  assert.equal(buf[0], 0x50, 'PK magic byte 0');
  assert.equal(buf[1], 0x4b, 'PK magic byte 1');
  assert.ok(buf.includes(Buffer.from('word/document.xml')), 'central directory names word/document.xml');
});

test('the packed document.xml carries native OMML equations and is well-formed', async () => {
  const dom = withDom();
  const { doc } = buildBufferFromFixture();
  const buf = await Packer.toBuffer(doc);
  const xml = inflateEntry(buf, 'word/document.xml');
  assert.ok(xml, 'word/document.xml present and inflatable');
  const s = xml.toString('utf8');
  assert.ok(s.includes('oMath'), 'raw inflated XML contains oMath (native equations)');
  assert.ok(!s.includes('<annotation'), 'no annotation elements leaked into the document');
  // exactly one section = a key "opens without repair" signal
  assert.equal((s.match(/<w:sectPr/g) || []).length, 1, 'exactly one sectionProperties');
  // at least the inline + display equation
  assert.ok((s.match(/<m:oMath[ >]/g) || []).length >= 2, 'inline + display equations present');
  // well-formedness: a strict XML parse must not error
  const parsed = new dom.window.DOMParser().parseFromString(s, 'text/xml');
  assert.equal(parsed.querySelector('parsererror'), null, 'document.xml parses as well-formed XML');
});

test('regression: no <undefined> wrapper tag around injected OMML (docx@9.7.1 fromXmlString bug)', async () => {
  // ImportedXmlComponent.fromXmlString() parses the OMML string as a full XML
  // *document* and, in docx@9.7.1, mis-tags that document node itself as an
  // element with rootKey=undefined instead of unwrapping to its one real
  // child. Left unfixed, every equation is packed as
  // <undefined><m:oMath>...</m:oMath></undefined>, which is well-formed XML
  // (so the other structural checks above stay green) but Word refuses to
  // open the file ("Word experienced an error trying to open the file").
  // See src/js/wordexport.js's importedXml() helper.
  const { doc } = buildBufferFromFixture();
  const buf = await Packer.toBuffer(doc);
  const s = inflateEntry(buf, 'word/document.xml').toString('utf8');
  assert.ok(!/<undefined[ >]/.test(s), 'no literal <undefined> element wrapping an equation');
  assert.ok(!s.includes('</undefined>'), 'no literal </undefined> closing tag');
  // broader net: the string "undefined" should never appear anywhere in a
  // real document (as an element name, an attribute value, or stray text) —
  // it's always a sign a JS value leaked into the XML unconverted.
  assert.ok(!s.includes('undefined'), 'the literal text "undefined" appears nowhere in document.xml');
});

test('buildDocx maps the whole feature set without throwing (headings, table, callout, code, image, footnote)', async () => {
  const { doc } = buildBufferFromFixture();
  const buf = await Packer.toBuffer(doc);
  const s = inflateEntry(buf, 'word/document.xml').toString('utf8');
  assert.ok(s.includes('Introduction'), 'heading text present');
  assert.ok(s.includes('Sample Report'), 'front-matter title present');
  assert.ok(s.includes('Notes'), 'footnotes rendered as a Notes section');
  assert.ok(/<w:tbl[ >]/.test(s), 'a table was emitted (grid table + callout)');
  assert.ok(/<pic:pic|<a:blip|<wp:inline/.test(s), 'the embedded image produced a drawing');
});

test('a mermaid fence degrades to a code block in DOCX when no engine is present', async () => {
  const dom = withDom();
  const r = render('```mermaid\ngraph TD; A-->B;\n```\n', {});
  const holder = dom.window.document.createElement('div');
  holder.innerHTML = r.html;
  applyPostDom(holder, { outline: r.outline, meta: r.meta, resolveAsset: null, forExport: true });
  const doc = buildDocx(holder, r.meta);
  const buf = await Packer.toBuffer(doc);
  const s = inflateEntry(buf, 'word/document.xml').toString('utf8');
  assert.ok(s.includes('graph TD') || s.includes('A--&gt;B') || s.includes('A-->B'), 'mermaid source preserved as text');
});

/* Research-driven regression battery (2026-07-09): the recurring multi-year
   bug classes in mature competitors' math→docx pipelines (Typora #696 \tag
   loss, #997 \over, #3201 mhchem) — pin Colophon's OMML path against them. */
test('OMML battery: aligned environments survive as native math', () => {
  withDom();
  const s = texToOmml('\\begin{aligned} a &= b + c \\\\ d &= e \\end{aligned}', true);
  assert.ok(s.includes('<m:oMath'), 'aligned renders to OMML');
  assert.ok(!s.includes('undefined'), 'no undefined leakage');
});

test('OMML battery: \\over, \\tfrac, nested fractions', () => {
  withDom();
  for (const tex of ['{a \\over b}', '\\tfrac{1}{2}', '\\frac{\\frac{a}{b}}{c}']) {
    const s = texToOmml(tex, false);
    assert.ok(s.includes('<m:oMath') && !s.includes('undefined'), tex);
  }
});

test('OMML battery: mhchem chemistry converts without exploding', () => {
  withDom();
  // \ce is KaTeX-extension territory; whatever happens it must not throw and
  // must not leak "undefined" attribute values into the XML
  let s = null;
  try { s = texToOmml('\\ce{H2O + CO2 -> H2CO3}', false); } catch { s = null; }
  if (s !== null) assert.ok(!String(s).includes('m:val="undefined"'));
});

test('OMML battery: \\tag/\\label numbering lifts cleanly (no \\tag in the tex Word sees)', () => {
  withDom();
  const { tex, number } = stripTag('x = y \\tag{7} \\label{eq:seven}');
  assert.equal(number, '7');
  assert.doesNotMatch(tex, /\\tag|\\label/);
  const s = texToOmml(tex, true);
  assert.ok(s.includes('<m:oMath'));
});

/* Finalization-sweep regressions (2026-07-12): the m:val="undefined" class,
   round two. mathml2omml only maps bold/italic/bold-italic — every OTHER
   mathvariant used to serialize as <m:sty m:val="undefined"> (the \infty bug
   that made Word refuse the file, back for \mathbb/\mathcal/\mathfrak/…). */
test('styled alphabets transliterate to Unicode math glyphs — no m:val="undefined"', () => {
  withDom();
  const cases = [
    ['\\mathbb{R}^n', 'ℝ'], ['\\mathbb{N}', 'ℕ'], ['\\mathcal{L}', 'ℒ'],
    ['\\mathfrak{g}', '𝔤'], ['\\mathsf{T}', '𝖳'], ['\\mathtt{x}', '𝚡'],
  ];
  for (const [tex, glyph] of cases) {
    const s = texToOmml(tex);
    assert.ok(s && s.includes('<m:oMath'), tex + ' converts');
    assert.doesNotMatch(s, /m:val="undefined"/, tex + ' has no undefined m:sty');
    assert.ok(s.includes(glyph), tex + ' carries the styled glyph ' + glyph);
  }
});

test('prescript (isotope) notation leaves no empty m:e placeholder box', () => {
  withDom();
  const s = texToOmml('{}^{14}_{6}\\mathrm{C}');
  assert.ok(s.includes('<m:oMath'));
  assert.doesNotMatch(s, /<m:e\s*\/>/, 'empty base filled (Word draws a dotted box for it)');
});
