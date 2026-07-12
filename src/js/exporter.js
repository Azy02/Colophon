/* Exports. Every serialized document is produced from the same render pipeline as
   the live preview, re-passed through sanitize(), and shares ONE export-DOM
   builder (renderForExport) so HTML / DOCX / Copy-for-Word never diverge. HTML/PDF
   carry a strict CSP and contain no scripts. DOCX embeds native Word equations
   (see wordexport.js); Copy-for-Word puts Word-targeted HTML (math as MathML) on
   the clipboard. */

import { render } from './pipeline.js';
import { applyPostDom } from './postdom.js';
import { sanitize } from './sanitize.js';
import { assetGet } from './store.js';
import { toast } from './ui.js';
import katex from 'katex';
import { buildDocx, packDocxBlob, stripTag } from './wordexport.js';
import { buildLatex } from './texexport.js';

const escapeHtml = (t) => String(t)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const baseName = (name) => String(name || 'document').replace(/\.(md|markdown|mdown|txt|bib)$/i, '') || 'document';

/* ---------- download helpers ---------- */
export function download(filename, text, mime) {
  downloadBlob(filename, new Blob([text], { type: mime || 'text/plain;charset=utf-8' }));
}
function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* ---------- standalone HTML document ---------- */
const CSP = '<meta http-equiv="Content-Security-Policy" '
  + "content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:\">";

const PAGE_CSS = [
  'html,body{margin:0;padding:0;background:#f4f2ee;}',
  'body{display:flex;justify-content:center;}',
  '.paper{width:100%;max-width:62rem;min-height:100vh;box-shadow:0 1px 44px rgba(20,18,14,.08);}',
  '@media print{ body{display:block;background:#fff;} .paper{max-width:none;box-shadow:none;} @page{margin:20mm 18mm 22mm;} }',
].join('\n');

/** Assemble a fully self-contained HTML document. bodyHtml is re-sanitized here
    (defense in depth); the KaTeX + reading CSS are pulled from the running app. */
export function buildStandaloneHtml({ title, bodyHtml, themeClass, styleClass, allowLocalRefs }) {
  const katexCss = (typeof document !== 'undefined' && document.getElementById('katex-style')?.textContent) || '';
  const readingCss = (typeof document !== 'undefined' && document.getElementById('reading-style')?.textContent) || '';
  let safeBody = sanitize(bodyHtml || '');
  if (allowLocalRefs) {
    // Relative project links (stashed as inert data-local-href by the gate)
    // may go LIVE in a standalone export: a static file has none of the app's
    // handlers, link navigation isn't CSP-governed, and the values are gate-
    // vetted (relative-only, no scheme, no '..'). This promotion must happen
    // AFTER the sanitize() above — promoting first is silently undone (the
    // gate re-stashes), which is exactly the bug this replaces. Images stay
    // embed-or-placeholder: the export CSP only allows img-src data:.
    const d = document.createElement('div');
    d.innerHTML = safeBody;                             // sanitized content
    for (const a of d.querySelectorAll('a[data-local-href]')) {
      a.setAttribute('href', a.getAttribute('data-local-href'));
      a.removeAttribute('data-local-href');
    }
    safeBody = d.innerHTML;
  }
  const cls = ['paper', themeClass || 'theme-light', styleClass || 'style-clean'].join(' ');
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    CSP,
    '<title>' + escapeHtml(title || 'Document') + '</title>',
    '<style id="katex-styles">' + katexCss + '</style>',
    '<style id="reading-styles">' + readingCss + '</style>',
    '<style id="page-styles">' + PAGE_CSS + '</style>',
    '</head>',
    '<body>',
    '<article class="' + cls + '">' + safeBody + '</article>',
    '</body>',
    '</html>',
  ].join('\n');
}

/* ---------- Markdown ---------- */
export function exportMarkdown(ctx) {
  download(baseName(ctx.currentName()) + '.md', ctx.getSource(), 'text/markdown;charset=utf-8');
  toast('Exported Markdown');
}

/* ---------- shared export DOM ---------- */
function firstHeading(container) {
  const h = container.querySelector('h1, h2, .doc-title');
  return h ? h.textContent.trim() : '';
}
function blobToDataURI(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}
/** Resolve colophon-asset: images to data URIs in-place and return an id→{dataURI,mime} map.
    In folder mode, relative-path images (real project files) inline the same way via
    ctx.resolveLocalImage — undefined means "no folder, leave the src alone". */
async function inlineAssets(container, ctx) {
  const assets = new Map();
  for (const img of container.querySelectorAll('img[src^="colophon-asset:"]')) {
    const id = img.getAttribute('src').slice('colophon-asset:'.length);
    try {
      const asset = await assetGet(id);
      if (asset && asset.blob) {
        const dataURI = await blobToDataURI(asset.blob);
        img.setAttribute('src', dataURI);
        assets.set(id, { dataURI, mime: asset.mime });
        continue;
      }
    } catch { /* fall through to placeholder */ }
    img.removeAttribute('src');
    img.setAttribute('alt', (img.getAttribute('alt') || '') + ' [missing local image]');
  }
  if (ctx && ctx.resolveLocalImage) {
    // relative srcs never survive the sanitizer — they arrive stashed as
    // inert data-local-src; a resolved project file becomes a data: URI
    for (const img of container.querySelectorAll('img[data-local-src]')) {
      const path = img.getAttribute('data-local-src') || '';
      let blob;
      try { blob = await ctx.resolveLocalImage(path); } catch { blob = null; }
      if (blob) {
        img.removeAttribute('data-local-src');
        try { img.setAttribute('src', await blobToDataURI(blob)); continue; } catch { /* fall through */ }
      }
      // Unresolvable (no folder linked, or the file is gone): promote the
      // as-authored relative path back to src — an exported HTML saved next to
      // the project still resolves it, and a visible broken-image icon beats
      // the previous state (an <img> with NO src: invisible in HTML, silently
      // dropped from DOCX/LaTeX). data-local-src stays for placeholder labels.
      img.setAttribute('src', path);
      if (blob === null) img.setAttribute('alt', (img.getAttribute('alt') || '') + ' [missing local image]');
    }
  }
  return assets;
}

/** The one export-DOM builder: fresh render → detached container → mermaid (static
    SVG when the engine is live) → postdom(forExport) → asset data-URIs. HTML, DOCX
    and Copy-for-Word all consume this identical DOM. */
export async function renderForExport(ctx) {
  const result = render(ctx.getSource(), ctx.renderOpts());
  const container = document.createElement('div');
  container.innerHTML = result.html;                 // sanitized pipeline output
  applyPostDom(container, { outline: result.outline, meta: result.meta, resolveAsset: null, forExport: true });
  if (ctx.mermaid && ctx.mermaid.isReady && ctx.mermaid.isReady()) {
    try { await ctx.mermaid.transform(container); } catch { /* leave fences as code blocks */ }
  }
  const assets = await inlineAssets(container, ctx);
  return { container, meta: result.meta, outline: result.outline, assets };
}

/* ---------- HTML ---------- */
export async function exportHtml(ctx) {
  const { container, meta } = await renderForExport(ctx);
  const title = (meta && meta.title) || firstHeading(container) || baseName(ctx.currentName());
  const html = buildStandaloneHtml({
    title,
    bodyHtml: container.innerHTML,
    allowLocalRefs: true,   // promotion happens INSIDE, after the re-sanitize
    themeClass: ctx.themeClass(),
    styleClass: ctx.styleClass(),
  });
  download(baseName(ctx.currentName()) + '.html', html, 'text/html;charset=utf-8');
  toast('Exported standalone HTML');
}

/* ---------- PDF (re-render, then the browser print dialog + print.css) ---------- */
export function exportPdf(ctx) {
  if (ctx.render) ctx.render();
  window.print();
}

/* ---------- DOCX (native equations) ---------- */
/* Word can't host SVG, so each mermaid diagram is drawn onto a canvas at 2×
   and swapped for a plain <img data-display-w> that the normal image path
   embeds (strict-mode mermaid SVG has no foreignObject, so the canvas stays
   untainted). Any failure leaves the wrap untouched — wordexport then falls
   back to the diagram source as a code block, exactly the pre-raster behavior. */
function svgToPngDataUri(svgEl) {
  return new Promise((resolve, reject) => {
    const vb = svgEl.viewBox && svgEl.viewBox.baseVal;
    // percentage width/height attrs would parseFloat to nonsense (100% → 100px)
    const attr = (name) => { const v = svgEl.getAttribute(name); return v && !v.includes('%') ? parseFloat(v) : NaN; };
    const w = (vb && vb.width) || attr('width') || 800;
    const h = (vb && vb.height) || attr('height') || 500;
    const clone = svgEl.cloneNode(true);
    clone.setAttribute('width', w); clone.setAttribute('height', h);
    // mermaid renders with font-family:inherit; an SVG loaded as an isolated
    // image resolves that to serif — pin the UI stack so labels keep the
    // metrics they were laid out with
    clone.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
    const xml = new XMLSerializer().serializeToString(clone);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = 2;
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const c2d = canvas.getContext('2d');
        c2d.fillStyle = '#ffffff';                     // Word pages are white; transparent PNGs gray out in dark mode
        c2d.fillRect(0, 0, canvas.width, canvas.height);
        c2d.drawImage(img, 0, 0, canvas.width, canvas.height);
        const dataURI = canvas.toDataURL('image/png');
        // Safari can return 'data:,' WITHOUT throwing past its canvas limit —
        // reject so the wrap (and its code fallback) survives
        if (!dataURI || !dataURI.startsWith('data:image/png') || dataURI.length < 100) { reject(new Error('empty raster')); return; }
        resolve({ dataURI, width: Math.round(w), height: Math.round(h) });
      } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error('svg rasterization failed'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  });
}
/* An <img> whose resolved src is an SVG data URI (an .svg figure from the
   asset store or a project folder) hits the same Word limitation as mermaid:
   Word can't host SVG, so the DOCX path would drop it to a "[image not
   embedded]" placeholder and pasted HTML would lose it. Decode the SVG and
   push it through the same 2× canvas raster as mermaid. Pure decode half is
   exported for tests; the canvas half only runs in a real browser. */
export function parseSvgDataUri(src) {
  const m = String(src || '').match(/^data:image\/svg\+xml([^,]*),([\s\S]*)$/i);
  if (!m) return null;
  try { return /;base64/i.test(m[1]) ? atob(m[2]) : decodeURIComponent(m[2]); }
  catch { return null; }
}
export async function rasterizeSvgImages(container) {
  let count = 0;
  for (const img of [...container.querySelectorAll('img')]) {
    const xml = parseSvgDataUri(img.getAttribute('src'));
    if (!xml) continue;
    const svgEl = new DOMParser().parseFromString(xml, 'image/svg+xml').documentElement;
    if (!svgEl || svgEl.nodeName !== 'svg') continue;    // parsererror → leave the placeholder path
    try {
      const { dataURI, width, height } = await svgToPngDataUri(svgEl);
      img.setAttribute('src', dataURI);
      img.setAttribute('data-display-w', String(width)); // DOCX placement size (bytes stay 2×)
      img.setAttribute('width', String(width));          // clipboard path: Word's HTML importer
      img.setAttribute('height', String(height));        //   honors width/height attrs
      count++;
    } catch { /* leave the img — DOCX reports it as not embedded */ }
  }
  return count;
}
export async function rasterizeMermaidSvgs(container) {
  let count = 0;
  for (const wrap of [...container.querySelectorAll('.mermaid-wrap')]) {
    const svg = wrap.querySelector('svg');
    if (!svg) continue;
    try {
      const { dataURI, width, height } = await svgToPngDataUri(svg);
      const img = document.createElement('img');
      img.setAttribute('src', dataURI);
      img.setAttribute('alt', 'diagram');
      img.setAttribute('data-display-w', String(width));   // DOCX placement size (bytes stay 2×)
      img.setAttribute('width', String(width));            // clipboard path: Word's HTML importer
      img.setAttribute('height', String(height));          // honors width/height attrs, not max-width
      const fig = document.createElement('figure');
      fig.appendChild(img);
      wrap.replaceWith(fig);
      count++;
    } catch { /* leave the wrap — DOCX falls back to the source code block */ }
  }
  return count;
}
export async function exportDocx(ctx) {
  try {
    const { container, meta } = await renderForExport(ctx);
    await rasterizeMermaidSvgs(container);
    await rasterizeSvgImages(container);
    const doc = buildDocx(container, meta);
    const blob = await packDocxBlob(doc);
    downloadBlob(baseName(ctx.currentName()) + '.docx', blob);
    toast('Exported Word .docx — equations are native');
  } catch (e) {
    toast('DOCX export failed — ' + ((e && e.message) || e), { kind: 'error' });
  }
}

/* ---------- LaTeX (.tex) — the reverse bridge (escape hatch, not submission-ready) ---------- */
export async function exportTex(ctx) {
  let container, meta;
  try { ({ container, meta } = await renderForExport(ctx)); }
  catch (e) { toast('LaTeX export failed \u2014 ' + ((e && e.message) || e), { kind: 'error' }); return; }
  let out;
  try { out = buildLatex(container, meta); }
  catch (e) { toast('LaTeX export failed \u2014 ' + ((e && e.message) || e), { kind: 'error' }); return; }
  download(baseName(ctx.currentName()) + '.tex', out.tex, 'application/x-tex;charset=utf-8');
  const note = out.notes && out.notes.length ? ' \u2014 ' + out.notes[0] : '';
  toast('Exported LaTeX (.tex) \u2014 a starting point for editing, not submission-ready' + note, { timeout: 6000 });
}

/* ---------- Copy for Word / Pages / Docs ----------
   Word-targeted HTML on the clipboard: each equation becomes a bare <math> element
   (annotation stripped — it trips Word warnings), which current Word/Pages/Docs
   convert to a native equation on paste. Critical styles are inlined because Word
   ignores CSS classes. Plain-text alternative is the raw Markdown. */
function katexMathML(tex, display) {
  const { tex: clean } = stripTag(tex);
  try {
    const html = katex.renderToString(clean, { output: 'mathml', displayMode: !!display, throwOnError: false, strict: 'ignore', trust: false });
    const tmp = document.createElement('div');
    tmp.innerHTML = html;                             // trusted KaTeX MathML, clipboard-only, never mounted
    const math = tmp.querySelector('math');
    if (!math) return null;
    for (const a of math.querySelectorAll('annotation')) a.remove();
    return math.outerHTML;
  } catch { return null; }
}

const STYLE = {
  pre: 'font-family:Consolas,"Courier New",monospace;background:#f5f3ee;border:1px solid #ddd;border-radius:6px;padding:10px 12px;white-space:pre-wrap;',
  code: 'font-family:Consolas,"Courier New",monospace;background:#f1efe8;padding:1px 3px;',
  blockquote: 'margin:8px 0 8px 8px;padding:2px 12px;border-left:3px solid #ccc;color:#555;font-style:italic;',
  table: 'border-collapse:collapse;',
  cell: 'border:1px solid #999;padding:4px 8px;',
  th: 'border:1px solid #999;padding:4px 8px;background:#eee;font-weight:bold;',
  alert: 'border-left:4px solid #888;padding:6px 12px;background:#f7f6f3;margin:10px 0;',
  img: 'max-width:100%;',
  figcap: 'font-style:italic;color:#555;text-align:center;',
};
function setStyle(el, css) { el.setAttribute('style', ((el.getAttribute('style') || '') + ';' + css).replace(/^;/, '')); }
function inlineCriticalStyles(root) {
  root.querySelectorAll('pre').forEach((el) => setStyle(el, STYLE.pre));
  root.querySelectorAll('code').forEach((el) => { if (!el.closest('pre')) setStyle(el, STYLE.code); });
  root.querySelectorAll('blockquote').forEach((el) => setStyle(el, STYLE.blockquote));
  root.querySelectorAll('table').forEach((el) => { setStyle(el, STYLE.table); el.setAttribute('border', '1'); el.setAttribute('cellspacing', '0'); });
  root.querySelectorAll('td').forEach((el) => setStyle(el, STYLE.cell));
  root.querySelectorAll('th').forEach((el) => setStyle(el, STYLE.th));
  root.querySelectorAll('.markdown-alert').forEach((el) => setStyle(el, STYLE.alert));
  root.querySelectorAll('img').forEach((el) => setStyle(el, STYLE.img));
  root.querySelectorAll('figcaption').forEach((el) => setStyle(el, STYLE.figcap));
}

async function writeClipboardHtml(fullHtml, bodyHtml, plain) {
  try {
    if (navigator.clipboard && navigator.clipboard.write && typeof ClipboardItem !== 'undefined') {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([fullHtml], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' }),
      })]);
      return true;
    }
  } catch { /* fall through to execCommand */ }
  return execCommandCopyHtml(bodyHtml);
}
function execCommandCopyHtml(bodyHtml) {
  try {
    const div = document.createElement('div');
    div.contentEditable = 'true';
    div.setAttribute('style', 'position:fixed;left:-9999px;top:0;opacity:0;');
    div.innerHTML = bodyHtml;                         // export HTML (sanitized pipeline + our wrappers), copy-only
    document.body.appendChild(div);
    const range = document.createRange();
    range.selectNodeContents(div);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const ok = document.execCommand('copy');
    sel.removeAllRanges();
    div.remove();
    return ok;
  } catch { return false; }
}

export async function exportWordCopy(ctx) {
  let container;
  try { ({ container } = await renderForExport(ctx)); }
  catch (e) { toast('Copy for Word failed — ' + ((e && e.message) || e), { kind: 'error' }); return; }
  const clone = container.cloneNode(true);
  await rasterizeMermaidSvgs(clone);   // Word drops pasted inline SVG; PNG survives
  await rasterizeSvgImages(clone);     // same for .svg figure assets
  for (const el of clone.querySelectorAll('[data-tex]')) {
    const mathml = katexMathML(el.getAttribute('data-tex'), el.getAttribute('data-display') === '1');
    if (!mathml) continue;
    const holder = document.createElement('span');
    holder.innerHTML = mathml;                        // trusted KaTeX MathML, clipboard-only
    const math = holder.firstElementChild;
    if (math) el.replaceWith(math);
  }
  inlineCriticalStyles(clone);
  const bodyHtml = clone.innerHTML;
  const fullHtml = '<html><head><meta charset="utf-8"></head><body>' + bodyHtml + '</body></html>';
  const ok = await writeClipboardHtml(fullHtml, bodyHtml, ctx.getSource());
  if (ok) toast('Copied — paste into Word/Pages/Docs (equations arrive native in current Word versions)');
  else toast('Copy blocked by the browser — try the DOCX export instead', { kind: 'error' });
}
