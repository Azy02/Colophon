/* DOCX export with NATIVE Word equations — the flagship feature.

   buildDocx(container, meta) walks the SAME sanitized, postdom(forExport:true)
   DOM that the HTML export uses (produced by exporter.renderForExport) and maps
   it to a docx.js Document. Math is the point: every .eq / .imath carries
   data-tex, which we re-render fresh through KaTeX to MathML, strip the
   <annotation> element (it triggers Word "Type not supported" warnings), convert
   MathML → OMML (mathml2omml), and inject as raw OMML via
   ImportedXmlComponent.fromXmlString — so equations arrive as real, editable Word
   equations rather than images.

   The document is built to open in Word with ZERO repair prompt: a single
   section, standard fonts (Consolas for code), well-formed OMML, images with a
   declared type and intrinsic dimensions. */

import katex from 'katex';
import { mml2omml } from 'mathml2omml';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  ExternalHyperlink, Table, TableRow, TableCell, WidthType, BorderStyle,
  ImageRun, ImportedXmlComponent, ShadingType, TabStopType, LevelFormat,
} from 'docx';

const HEAD = {
  h1: HeadingLevel.HEADING_1, h2: HeadingLevel.HEADING_2, h3: HeadingLevel.HEADING_3,
  h4: HeadingLevel.HEADING_4, h5: HeadingLevel.HEADING_5, h6: HeadingLevel.HEADING_6,
};
const ALERT_COLORS = { note: '2F5C7F', tip: '3F6A38', important: '6E3D87', warning: '8A6410', caution: 'A33D28' };
const CODE_FILL = 'F4F2EE', CODE_FG = '3A362E', INLINE_CODE_FILL = 'EFEDE8';
const MAX_IMG_PX = 624;         // 6.5 in at 96 dpi (letter, 1-in margins)
const RIGHT_TAB = 9350;         // ≈ right margin, for equation numbers

/* ---------- KaTeX TeX → OMML (the core of the feature) ---------- */

/** Split a trailing \tag{…}/\label{…} off the TeX, returning the clean TeX plus
    the equation number (from \tag) if any. \label never reaches KaTeX MathML. */
export function stripTag(tex) {
  let number = null;
  let t = String(tex == null ? '' : tex);
  t = t.replace(/\\tag\*?\s*\{([^}]*)\}/, (_, n) => { number = n.trim(); return ''; });
  t = t.replace(/\\label\s*\{[^}]*\}/g, '');
  return { tex: t.trim(), number };
}

/** TeX → OMML string ('<m:oMath …>…</m:oMath>'). Throws on a hard KaTeX failure;
    the returned string is guaranteed to contain no <annotation>. Requires a DOM
    (browser, or jsdom with a global `document`) to parse the MathML. */
export function texToOmml(tex, displayMode) {
  const html = katex.renderToString(String(tex ?? ''), {
    output: 'mathml', displayMode: !!displayMode, throwOnError: false, strict: 'ignore', trust: false,
  });
  // Detached, never-mounted scratch element used only to reach the <math> node;
  // KaTeX MathML is our own trusted output (not user HTML) and is read, not shown.
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const math = tmp.querySelector('math');
  if (!math) return null;
  for (const a of math.querySelectorAll('annotation')) a.remove();   // avoids Word "Type not supported"
  // mathml2omml@0.5.0 maps mathvariant through a fixed {bold,italic,bold-italic}
  // table — EVERY other value serializes verbatim as <m:sty m:val="undefined">,
  // the exact defect class that made Word refuse the file (first found for
  // \infty's mathvariant="normal"; the 2026-07-12 sweep found it again for
  // \mathbb/\mathcal/\mathfrak/\mathsf/\mathtt). 'normal' just means "no
  // override" → drop the attribute. Styled alphabets are transliterated to
  // their dedicated Unicode math-alphanumeric codepoints (Cambria Math covers
  // the block), so ℝ stays blackboard-bold in Word; unknown variants degrade
  // to plain glyphs rather than a broken file.
  for (const el of math.querySelectorAll('[mathvariant]')) {
    const v = el.getAttribute('mathvariant');
    if (v === 'bold' || v === 'italic' || v === 'bold-italic') continue;   // library handles these
    if (v !== 'normal') el.textContent = toMathAlphabet(el.textContent, v);
    el.removeAttribute('mathvariant');
  }
  const omml = mml2omml(math.outerHTML);
  return (omml && omml.indexOf('<m:oMath') !== -1) ? fixNaryEmptyBases(omml) : null;
}

/* Unicode Mathematical Alphanumeric Symbols: per-variant codepoint bases for
   A–Z / a–z / 0–9 plus the Letterlike Symbols exceptions carved out of the
   block (ℝ, ℂ, ℋ, ℜ, …). Characters with no mapping pass through unchanged. */
const MATH_ALPHA = {
  'double-struck': { A: 0x1D538, a: 0x1D552, d: 0x1D7D8,
    X: { C: 0x2102, H: 0x210D, N: 0x2115, P: 0x2119, Q: 0x211A, R: 0x211D, Z: 0x2124 } },
  'script': { A: 0x1D49C, a: 0x1D4B6,
    X: { B: 0x212C, E: 0x2130, F: 0x2131, H: 0x210B, I: 0x2110, L: 0x2112, M: 0x2133, R: 0x211B, e: 0x212F, g: 0x210A, o: 0x2134 } },
  'bold-script': { A: 0x1D4D0, a: 0x1D4EA },
  'fraktur': { A: 0x1D504, a: 0x1D51E,
    X: { C: 0x212D, H: 0x210C, I: 0x2111, R: 0x211C, Z: 0x2128 } },
  'bold-fraktur': { A: 0x1D56C, a: 0x1D586 },
  'sans-serif': { A: 0x1D5A0, a: 0x1D5BA, d: 0x1D7E2 },
  'bold-sans-serif': { A: 0x1D5D4, a: 0x1D5EE, d: 0x1D7EC },
  'sans-serif-italic': { A: 0x1D608, a: 0x1D622 },
  'sans-serif-bold-italic': { A: 0x1D63C, a: 0x1D656 },
  'monospace': { A: 0x1D670, a: 0x1D68A, d: 0x1D7F6 },
};
function toMathAlphabet(s, variant) {
  const t = MATH_ALPHA[variant];
  if (!t) return s;
  let out = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (t.X && t.X[ch] != null) out += String.fromCodePoint(t.X[ch]);
    else if (c >= 65 && c <= 90 && t.A) out += String.fromCodePoint(t.A + c - 65);
    else if (c >= 97 && c <= 122 && t.a) out += String.fromCodePoint(t.a + c - 97);
    else if (c >= 48 && c <= 57 && t.d) out += String.fromCodePoint(t.d + c - 48);
    else out += ch;
  }
  return out;
}

const OMML_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
// Top-level relation characters that end an n-ary operator's operand. Note
// mathml2omml fuses adjacent same-style tokens into one run, so a relation
// usually arrives glued to the operand tail ("dx=") rather than alone.
const REL_CHAR_RE = /[=≠<>≤≥≈∼≃≅≪≫∝→←↔⇒⇐⇔∈∉∋⊂⊃⊆⊇≡]/;

/** KaTeX's MathML for \int/\sum/\prod puts the operand *after* the
    <msubsup><mo>∫</mo>…</msubsup> as siblings, so mathml2omml@0.5.0 emits
    <m:nary> with an EMPTY <m:e/> base and the operand outside it. Word renders
    an empty m:e as a dotted placeholder box — verified visually in real Word
    (∫₀^∞ ⬚ e^(−x²)dx). Repair: move the n-ary's following siblings into its
    empty base, stopping at the first top-level relation character (=, <, →, …);
    a run that fuses operand and relation ("dx=") is split so the operand part
    lands inside. Rightmost n-ary first, so iterated operators nest correctly. */
function fixNaryEmptyBases(omml) {
  let doc;
  try { doc = new DOMParser().parseFromString(omml, 'text/xml'); } catch { return omml; }
  if (!doc || doc.querySelector('parsererror')) return omml;
  const naries = [...doc.getElementsByTagNameNS(OMML_NS, 'nary')];
  for (const nary of naries.reverse()) {
    const base = [...nary.children].find((c) => c.localName === 'e' && c.namespaceURI === OMML_NS);
    if (!base || base.childNodes.length) continue;      // only repair EMPTY bases
    let sib = nary.nextSibling;
    while (sib) {
      const next = sib.nextSibling;
      if (sib.nodeType === 1 && sib.localName === 'r' && sib.namespaceURI === OMML_NS) {
        const ts = [...sib.getElementsByTagNameNS(OMML_NS, 't')];
        const text = ts.map((t) => t.textContent).join('');
        const i = text.search(REL_CHAR_RE);
        if (i === 0) break;                             // relation first → run stays outside
        if (i > 0) {
          if (ts.length === 1) {                        // fused "dx=" → split at the relation
            const operandRun = sib.cloneNode(true);
            operandRun.getElementsByTagNameNS(OMML_NS, 't')[0].textContent = text.slice(0, i);
            ts[0].textContent = text.slice(i);
            base.appendChild(operandRun);
          }
          break;                                        // relation (and after) stays outside
        }
      }
      base.appendChild(sib);                            // appendChild moves the node
      sib = next;
    }
  }
  // Prescript-style TeX ({}^{14}_{6}C — isotope notation) leaves a genuinely
  // empty base on m:sSub/sSup/sSubSup, the same dotted-placeholder-box defect
  // Word draws for empty n-ary bases. A zero-width-space run keeps the script
  // attached to the following glyph with no visible box.
  for (const tag of ['sSub', 'sSup', 'sSubSup']) {
    for (const el of [...doc.getElementsByTagNameNS(OMML_NS, tag)]) {
      const base = [...el.children].find((c) => c.localName === 'e' && c.namespaceURI === OMML_NS);
      if (!base || base.childNodes.length) continue;
      const r = doc.createElementNS(OMML_NS, 'm:r');
      const t = doc.createElementNS(OMML_NS, 'm:t');
      t.textContent = '\u200B';
      r.appendChild(t);
      base.appendChild(r);
    }
  }
  const win = (typeof window !== 'undefined' && window) || globalThis;
  return new win.XMLSerializer().serializeToString(doc.documentElement);
}

/** docx@9.7.1's ImportedXmlComponent.fromXmlString() parses the OMML string as a
    whole XML *document* and mis-tags that document node itself as an element
    with rootKey=undefined, instead of unwrapping to its one real child — every
    injected equation was coming out as `<undefined><m:oMath>...</m:oMath></undefined>`,
    which Word refuses to open ("Word experienced an error trying to open the
    file"). Unwrap it here so the real <m:oMath> element is what actually gets
    inserted into the paragraph. */
function importedXml(xmlString) {
  const wrapper = ImportedXmlComponent.fromXmlString(xmlString);
  return wrapper.root.find((c) => c instanceof ImportedXmlComponent) || wrapper;
}

/* ---------- inline run styling ---------- */
function runProps(s) {
  const o = {};
  if (s.bold) o.bold = true;
  if (s.italics) o.italics = true;
  if (s.strike) o.strike = true;
  if (s.superScript) o.superScript = true;
  if (s.subScript) o.subScript = true;
  if (s.color) o.color = s.color;
  if (s.underline) o.underline = {};
  if (s.highlight) o.highlight = s.highlight;
  if (s.font) o.font = s.font;
  if (s.size) o.size = s.size;
  return o;
}

/** childNodes → array of docx inline children (TextRun / hyperlink / oMath / image). */
function inlineRuns(node, style = {}) {
  const out = [];
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {                       // text
      const t = child.textContent;
      if (t) out.push(new TextRun({ text: t, ...runProps(style) }));
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child, tag = el.tagName.toLowerCase(), cls = el.classList;
    if (cls.contains('imath')) { pushInlineMath(el, out, style); continue; }
    // raw KaTeX subtrees and decorative spans carry no authored text we want
    if (cls.contains('katex') || cls.contains('katex-display')
      || cls.contains('hnum') || cls.contains('sr-only')) continue;
    switch (tag) {
      case 'strong': case 'b': out.push(...inlineRuns(el, { ...style, bold: true })); break;
      case 'em': case 'i': case 'cite': out.push(...inlineRuns(el, { ...style, italics: true })); break;
      case 'del': case 's': case 'strike': out.push(...inlineRuns(el, { ...style, strike: true })); break;
      case 'sup': out.push(...inlineRuns(el, { ...style, superScript: true })); break;
      case 'sub': out.push(...inlineRuns(el, { ...style, subScript: true })); break;
      case 'mark': out.push(...inlineRuns(el, { ...style, highlight: 'yellow' })); break;
      case 'br': out.push(new TextRun({ break: 1 })); break;
      case 'code': out.push(new TextRun({
        text: el.textContent, font: 'Consolas', ...runProps(style),
        shading: { type: ShadingType.CLEAR, fill: INLINE_CODE_FILL, color: 'auto' },
      })); break;
      case 'a': pushLink(el, out, style); break;
      case 'img': out.push(imageRun(el) || missingImageRun(el)); break;
      default: out.push(...inlineRuns(el, style));
    }
  }
  return out;
}

function pushInlineMath(el, out, style) {
  const raw = el.getAttribute('data-tex') || '';
  const { tex } = stripTag(raw);
  try {
    const omml = texToOmml(tex, false);
    if (omml) { out.push(importedXml(omml)); return; }
  } catch { /* fall through to text */ }
  out.push(new TextRun({ text: tex || el.textContent || '', italics: true, ...runProps(style) }));
}

function pushLink(a, out, style) {
  const href = a.getAttribute('href') || '';
  if (/^(https?:|mailto:)/i.test(href)) {
    out.push(new ExternalHyperlink({ link: href, children: inlineRuns(a, { ...style, color: '1A5FB4', underline: true }) }));
  } else {
    out.push(...inlineRuns(a, { ...style, color: 'BF5B3E' }));   // internal/#anchor → styled text
  }
}

/* ---------- images ---------- */
function base64ToBytes(b64) {
  const s = b64.replace(/\s+/g, '');
  if (typeof atob === 'function') {
    const bin = atob(s); const a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a;
  }
  return new Uint8Array(Buffer.from(s, 'base64'));   // node without global atob
}
/** Intrinsic pixel size from image bytes (offline, no decode). null → unknown. */
function imageSize(b, type) {
  try {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (type === 'png' && b.length >= 24) return { w: dv.getUint32(16), h: dv.getUint32(20) };
    if (type === 'gif' && b.length >= 10) return { w: dv.getUint16(6, true), h: dv.getUint16(8, true) };
    if (type === 'bmp' && b.length >= 26) return { w: dv.getInt32(18, true), h: Math.abs(dv.getInt32(22, true)) };
    if (type === 'jpg') {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xFF) { i++; continue; }
        const marker = b[i + 1];
        if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker))
          return { h: dv.getUint16(i + 5), w: dv.getUint16(i + 7) };
        if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
        i += 2 + dv.getUint16(i + 2);
      }
    }
  } catch { /* ignore */ }
  return null;
}
function imageRun(img) {
  const src = img.getAttribute('src') || '';
  const m = src.match(/^data:([^;,]+)(;base64)?,([\s\S]*)$/);
  if (!m) return null;                                 // http(s) can't be embedded offline
  const mime = m[1].toLowerCase();
  const type = mime.includes('png') ? 'png'
    : (mime.includes('jpeg') || mime.includes('jpg')) ? 'jpg'
    : mime.includes('gif') ? 'gif'
    : mime.includes('bmp') ? 'bmp' : null;
  if (!type) return null;                              // svg/unknown → skip (mermaid handled elsewhere)
  let bytes;
  try { bytes = m[2] ? base64ToBytes(m[3]) : new TextEncoder().encode(decodeURIComponent(m[3])); }
  catch { return null; }
  const dim = imageSize(bytes, type) || { w: 480, h: 320 };
  let { w, h } = dim;
  if (!w || !h) { w = 480; h = 320; }
  // display-size hint (set by the mermaid rasterizer, which renders at 2× for
  // crispness): bytes stay hi-res, the placed size stays the CSS size
  const hintW = parseInt(img.getAttribute('data-display-w') || '', 10);
  if (hintW > 0 && w) { h = Math.round(h * hintW / w); w = hintW; }
  if (w > MAX_IMG_PX) { h = Math.round(h * MAX_IMG_PX / w); w = MAX_IMG_PX; }
  return new ImageRun({ data: bytes, type, transformation: { width: w, height: h } });
}

/* ---------- block builders ---------- */
function codeLines(text) {
  const lines = String(text).replace(/\n$/, '').split('\n');
  const runs = [];
  lines.forEach((ln, i) => {
    if (i) runs.push(new TextRun({ break: 1 }));
    runs.push(new TextRun({ text: ln, font: 'Consolas', size: 18, color: CODE_FG }));
  });
  return [new Paragraph({
    children: runs.length ? runs : [new TextRun({ text: '', font: 'Consolas' })],
    shading: { type: ShadingType.CLEAR, fill: CODE_FILL, color: 'auto' },
    border: {
      top: { style: BorderStyle.SINGLE, size: 4, color: 'DDD9D0', space: 6 },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: 'DDD9D0', space: 6 },
      left: { style: BorderStyle.SINGLE, size: 4, color: 'DDD9D0', space: 8 },
      right: { style: BorderStyle.SINGLE, size: 4, color: 'DDD9D0', space: 8 },
    },
    spacing: { before: 120, after: 120 },
  })];
}
function codeBlock(el) {
  const code = el.querySelector('code') || el;
  return codeLines(code.textContent);
}

function displayEq(el) {
  const { tex, number } = stripTag(el.getAttribute('data-tex') || '');
  let comp = null;
  try { const omml = texToOmml(tex, true); if (omml) comp = importedXml(omml); }
  catch { /* fall through */ }
  const body = comp ? [comp] : [new TextRun({ text: tex, italics: true })];
  if (number != null && number !== '') {
    // journal style: equation left, number right-tabbed — a clean, Word-native layout
    return new Paragraph({
      children: [...body, new TextRun({ text: '\t(' + number + ')' })],
      tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB }],
      spacing: { before: 160, after: 160 },
    });
  }
  return new Paragraph({ children: body, alignment: AlignmentType.CENTER, spacing: { before: 160, after: 160 } });
}

function tableToDocx(el) {
  const rows = [];
  for (const tr of el.querySelectorAll('tr')) {
    const header = !!tr.closest('thead') || (!tr.closest('tbody') && !!tr.querySelector('th'));
    const cells = [];
    for (const cell of tr.children) {
      if (cell.nodeType !== 1) continue;
      cells.push(new TableCell({
        children: [new Paragraph({ children: inlineRuns(cell, header ? { bold: true } : {}) })],
        shading: header ? { type: ShadingType.CLEAR, fill: 'EEECE7', color: 'auto' } : undefined,
        margins: { top: 40, bottom: 40, left: 90, right: 90 },
      }));
    }
    if (cells.length) rows.push(new TableRow({ children: cells, tableHeader: header }));
  }
  const line = { style: BorderStyle.SINGLE, size: 4, color: '9C978C' };
  return new Table({
    rows: rows.length ? rows : [new TableRow({ children: [new TableCell({ children: [new Paragraph({})] })] })],
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: line },
  });
}

function listToDocx(listEl, ordered, level, B, out) {
  const lvl = Math.min(level, 2);
  const instance = ordered ? B.olSeq++ : 0;
  for (const li of listEl.children) {
    if (li.tagName !== 'LI') continue;
    // This item's own inline content, excluding nested <ul>/<ol> (recursed separately below).
    const itemRuns = [];
    for (const n of li.childNodes) {
      if (n.nodeType === 1 && (n.tagName === 'UL' || n.tagName === 'OL')) continue;
      if (n.nodeType === 1) itemRuns.push(...inlineRuns(n, {}));
      else if (n.nodeType === 3 && n.textContent.trim()) itemRuns.push(new TextRun({ text: n.textContent }));
    }
    out.push(new Paragraph({
      children: itemRuns.length ? itemRuns : [new TextRun('')],
      ...(ordered
        ? { numbering: { reference: 'colophon-num', level: lvl, instance } }
        : { bullet: { level: lvl } }),
    }));
    for (const n of li.children) {
      if (n.tagName === 'UL') listToDocx(n, false, level + 1, B, out);
      else if (n.tagName === 'OL') listToDocx(n, true, level + 1, B, out);
    }
  }
}

function blockquote(el, B) {
  const out = [];
  const line = { left: { style: BorderStyle.SINGLE, size: 12, color: 'C9C4B8', space: 10 } };
  for (const child of el.children) {
    if (child.tagName === 'P') {
      out.push(new Paragraph({ children: inlineRuns(child, { italics: true }), indent: { left: 480 }, border: line }));
    } else {
      const sub = []; walkBlock(child, B, sub); out.push(...sub);
    }
  }
  if (!out.length) out.push(new Paragraph({ children: inlineRuns(el, { italics: true }), indent: { left: 480 }, border: line }));
  return out;
}

function alertToDocx(el, B) {
  let type = 'note';
  for (const c of el.classList) { const m = c.match(/^markdown-alert-(\w+)$/); if (m && ALERT_COLORS[m[1]]) type = m[1]; }
  const color = ALERT_COLORS[type];
  const paras = [];
  const titleEl = el.querySelector('.markdown-alert-title');
  if (titleEl) paras.push(new Paragraph({ children: [new TextRun({ text: titleEl.textContent.trim() || type.toUpperCase(), bold: true, color })] }));
  for (const child of el.children) {
    if (child.classList && child.classList.contains('markdown-alert-title')) continue;
    const sub = []; walkBlock(child, B, sub); paras.push(...sub);
  }
  if (!paras.length) paras.push(new Paragraph({}));
  const thin = { style: BorderStyle.SINGLE, size: 2, color: 'E6E4DF' };
  const cell = new TableCell({
    children: paras,
    borders: { left: { style: BorderStyle.SINGLE, size: 24, color }, top: thin, bottom: thin, right: thin },
    shading: { type: ShadingType.CLEAR, fill: 'F7F6F3', color: 'auto' },
    margins: { top: 80, bottom: 80, left: 160, right: 140 },
  });
  return new Table({ rows: [new TableRow({ children: [cell] })], width: { size: 100, type: WidthType.PERCENTAGE } });
}

/* An image that can't be embedded (missing project file, remote URL offline,
   unsupported format) must leave a VISIBLE trace — a silently vanished figure
   in a .docx is data loss the author only discovers after sending the file. */
function missingImageRun(img) {
  const ref = img.getAttribute('data-local-src') || img.getAttribute('src') || img.getAttribute('alt') || 'image';
  const label = /^data:/i.test(ref) ? 'image' : ref;
  return new TextRun({ text: '[image not embedded: ' + label + ']', italics: true, color: '999999' });
}
function figureToDocx(el) {
  const out = [];
  const img = el.querySelector('img');
  if (img) {
    const r = imageRun(img) || missingImageRun(img);
    out.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [r] }));
  }
  const cap = el.querySelector('figcaption');
  if (cap) out.push(new Paragraph({ alignment: AlignmentType.CENTER, children: inlineRuns(cap, { italics: true }), spacing: { after: 120 } }));
  return out;
}

function titleBlock(el) {
  const out = [];
  const pick = (sel) => el.querySelector(sel);
  const title = pick('.doc-title'), subtitle = pick('.doc-subtitle'), byline = pick('.doc-byline'), abstract = pick('.doc-abstract');
  if (title) out.push(new Paragraph({ heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, children: [new TextRun({ text: title.textContent, bold: true })] }));
  if (subtitle) out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: [new TextRun({ text: subtitle.textContent, italics: true, color: '6B6B6B', size: 26 })] }));
  if (byline) out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 160 }, children: [new TextRun({ text: byline.textContent.replace(/\s*·\s*/g, '  ·  ').replace(/\s+/g, ' ').trim(), color: '555555' })] }));
  if (abstract) out.push(new Paragraph({ children: [new TextRun({ text: abstract.textContent.replace(/^Abstract\.?\s*/i, 'Abstract.  '), size: 20 })], indent: { left: 720, right: 720 }, spacing: { before: 80, after: 160 } }));
  return out;
}

function refsSection(el, B) {
  const out = [];
  const h = el.querySelector('h2');
  if (h) out.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(h.textContent)] }));
  for (const li of el.querySelectorAll('li')) out.push(new Paragraph({ children: inlineRuns(li, {}), spacing: { after: 60 } }));
  return out;
}

function footnotesSection(el, B) {
  const out = [new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('Notes')] })];
  const lis = [...el.querySelectorAll('ol > li')];
  lis.forEach((li, i) => {
    const clone = li.cloneNode(true);
    for (const a of clone.querySelectorAll('[data-footnote-backref]')) a.remove();
    out.push(new Paragraph({ children: [new TextRun({ text: (i + 1) + '. ', bold: true }), ...inlineRuns(clone, {})], spacing: { after: 40 } }));
  });
  return out;
}

function tocSection(el) {
  const out = [];
  const title = el.querySelector('.toc-title');
  if (title) out.push(new Paragraph({ children: [new TextRun({ text: title.textContent, bold: true })], spacing: { after: 40 } }));
  for (const a of el.querySelectorAll('a')) out.push(new Paragraph({ children: [new TextRun(a.textContent)], indent: { left: 360 }, spacing: { after: 20 } }));
  return out;
}

function mermaidCode(el) {
  // Roadmap: mermaid SVG → EMF is out of scope for DOCX v1. Emit the diagram
  // source as a code block so nothing is lost.
  const src = el.getAttribute('data-src')
    || (el.querySelector('code') && el.querySelector('code').textContent)
    || el.textContent || '';
  return codeLines(src);
}

/* ---------- the walker ---------- */
function walkBlock(el, B, out) {
  if (!el || el.nodeType !== 1) return;
  const tag = el.tagName.toLowerCase();
  const cls = el.classList;
  if (cls.contains('bib-chip') || cls.contains('code-tools')) return;
  if (cls.contains('mermaid-wrap') || cls.contains('mermaid-error')) { out.push(...mermaidCode(el)); return; }
  if (cls.contains('eq')) { out.push(displayEq(el)); return; }
  if (cls.contains('code-wrap')) { out.push(...codeBlock(el)); return; }
  if (cls.contains('markdown-alert')) { out.push(alertToDocx(el, B)); return; }
  if (cls.contains('doc-header')) { out.push(...titleBlock(el)); return; }
  if (cls.contains('references')) { out.push(...refsSection(el, B)); return; }
  if (cls.contains('footnotes')) { out.push(...footnotesSection(el, B)); return; }
  if (cls.contains('toc')) { out.push(...tocSection(el)); return; }

  switch (tag) {
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
      out.push(new Paragraph({ heading: HEAD[tag], children: inlineRuns(el, {}) })); return;
    case 'p': {
      const runs = inlineRuns(el, {});
      if (!runs.length) return;                       // drop the empty <p></p> the pipeline leaves around blocks
      out.push(new Paragraph({ children: runs, ...(cls.contains('tbl-caption') ? { alignment: AlignmentType.CENTER } : {}) })); return;
    }
    case 'pre': out.push(...codeBlock(el)); return;
    case 'ul': listToDocx(el, false, 0, B, out); return;
    case 'ol': listToDocx(el, true, 0, B, out); return;
    case 'blockquote': out.push(...blockquote(el, B)); return;
    case 'table': out.push(tableToDocx(el)); return;
    case 'figure': out.push(...figureToDocx(el)); return;
    case 'img': out.push(...figureToDocx(el)); return;
    case 'hr': out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC' } }, spacing: { before: 120, after: 120 } })); return;
    case 'section': case 'div': case 'article': case 'main':
      for (const c of el.children) walkBlock(c, B, out); return;
    default: {
      const runs = inlineRuns(el, {});
      if (runs.length) out.push(new Paragraph({ children: runs }));
    }
  }
}

/* ---------- public API ---------- */
/** Build a docx.js Document from a rendered export container. */
export function buildDocx(container, meta = {}) {
  const B = { olSeq: 1 };
  const children = [];
  for (const el of [...container.children]) walkBlock(el, B, children);
  if (!children.length) children.push(new Paragraph({ children: [new TextRun('')] }));   // Word dislikes empty bodies
  const authors = (meta && Array.isArray(meta.authors)) ? meta.authors.join(', ') : '';
  return new Document({
    creator: authors || 'Colophon',
    title: (meta && meta.title) ? String(meta.title) : undefined,
    numbering: {
      config: [{
        reference: 'colophon-num',
        levels: [
          { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } },
          { level: 1, format: LevelFormat.LOWER_LETTER, text: '%2.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 1440, hanging: 360 } } } },
          { level: 2, format: LevelFormat.LOWER_ROMAN, text: '%3.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 2160, hanging: 360 } } } },
        ],
      }],
    },
    sections: [{
      properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      children,
    }],
  });
}

/** Pack a Document to a Blob (browser) for download. */
export function packDocxBlob(doc) { return Packer.toBlob(doc); }
