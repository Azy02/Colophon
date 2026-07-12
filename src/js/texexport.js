/* Markdown → LaTeX (.tex) export — the reverse bridge (pure, testable).

   buildLatex(container, meta) walks the SAME sanitized, postdom(forExport:true)
   DOM every other export uses (from exporter.renderForExport) and emits a
   standalone .tex string. Deliberately a ONE-WAY ESCAPE HATCH, not a submission
   pipeline (see docs/research/latex-conversion-fidelity.md): "a starting point
   for further editing," never per-journal document classes, never a bibliography
   build. Two things make the honest version nearly free and correct:
     - math is a COPY, not a translation: every .eq/.imath carries its original
       TeX in data-tex, so it round-trips byte-for-byte;
     - [@key] citations reverse to \cite{key} by lookup, not re-derivation.
   Preamble mirrors pandoc's own template (verified): amsmath/amssymb always;
   graphicx only with images; longtable/booktabs/array only with tables;
   hyperref always, loaded last. */

/* ---- LaTeX escaping for PROSE text only (never math/code/verbatim) ----
   Single pass: escaping in two passes would let the first pass's own braces
   (\textasciitilde{}) get re-escaped by the second. */
const ESC = {
  '\\': '\\textbackslash{}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}',
  '&': '\\&', '%': '\\%', '$': '\\$', '#': '\\#', '_': '\\_', '{': '\\{', '}': '\\}',
};
function escapeText(s) {
  return String(s == null ? '' : s).replace(/[\\~^&%$#_{}]/g, (c) => ESC[c]);
}

/* Split a trailing \tag{…}/\label{…} off the TeX (the numbering the pipeline
   baked in), returning clean TeX. The real label is recovered from the
   element id instead, so a \ref still points somewhere. */
function cleanTex(tex) {
  return String(tex == null ? '' : tex)
    .replace(/\\tag\*?\s*\{[^}]*\}/g, '')
    .replace(/\\label\s*\{[^}]*\}/g, '')
    .trim();
}
/* id "eq-foo" / "fig-bar" → LaTeX label "eq:foo" / "fig:bar". If the label was
   already namespaced (\label{eq:kp} → id "eq-eq:kp"), don't re-prefix it into
   "eq:eq:kp" — return the already-namespaced remainder as-is. */
function idToLabel(id) {
  if (!id) return '';
  const m = id.match(/^(eq|fig|tbl|sec)-([\s\S]+)$/);
  if (!m) return id;
  return /^(eq|fig|tbl|sec):/.test(m[2]) ? m[2] : m[1] + ':' + m[2];
}

const HEAD = { h1: 'section', h2: 'subsection', h3: 'subsubsection', h4: 'paragraph', h5: 'subparagraph', h6: 'subparagraph' };

/* ---- inline walker: a node's children → an inline LaTeX string ---- */
function inlineTex(node, ctx) {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) { out += escapeText(child.textContent); continue; }
    if (child.nodeType !== 1) continue;
    const el = child, tag = el.tagName.toLowerCase(), cls = el.classList;
    if (cls.contains('imath')) { out += '$' + cleanTex(el.getAttribute('data-tex')) + '$'; continue; }
    if (cls.contains('katex') || cls.contains('katex-display') || cls.contains('sr-only') || cls.contains('hnum')) continue;
    if (cls.contains('cite') || cls.contains('cite-unresolved')) { // [@key] (resolved or not) → \cite{key}
      // an UNRESOLVED citation still shows "[@key]" as text; a RESOLVED one
      // renders its label ("[1]", "(Doe, 2020)") — there the key survives
      // only in the href ("#ref-<key>")
      let keys = [...(el.textContent || '').matchAll(/@([\w:.-]+)/g)].map((m) => m[1]);
      const href = el.getAttribute('href') || '';
      if (!keys.length && href.startsWith('#ref-')) keys = [href.slice(5)];
      if (keys.length) { out += '\\cite{' + keys.join(',') + '}'; ctx.usedCite = true; }
      else out += inlineTex(el, ctx);
      continue;
    }
    if ((cls.contains('eqref') || cls.contains('xref')) && (el.getAttribute('href') || '').startsWith('#')) {
      out += '\\ref{' + idToLabel(el.getAttribute('href').slice(1)) + '}'; continue;
    }
    if (tag === 'sup') {                                          // footnote reference → \footnote{body}
      const a = el.querySelector('a[data-footnote-ref], a[href^="#footnote"]');
      const id = a && (a.getAttribute('href') || '').slice(1);
      if (id && ctx.footnotes[id] != null) { out += '\\footnote{' + footnoteTex(ctx.footnotes[id], ctx) + '}'; continue; }
      out += '\\textsuperscript{' + inlineTex(el, ctx) + '}'; continue;
    }
    switch (tag) {
      case 'strong': case 'b': out += '\\textbf{' + inlineTex(el, ctx) + '}'; break;
      case 'em': case 'i': out += '\\emph{' + inlineTex(el, ctx) + '}'; break;
      case 'code': out += '\\texttt{' + escapeText(el.textContent) + '}'; break;
      case 'del': case 's': out += '\\sout{' + inlineTex(el, ctx) + '}'; ctx.usedStrike = true; break;
      case 'sup': out += '\\textsuperscript{' + inlineTex(el, ctx) + '}'; break;
      case 'sub': out += '\\textsubscript{' + inlineTex(el, ctx) + '}'; break;
      case 'br': out += ' \\\\ '; break;
      case 'a': {
        const href = el.getAttribute('href') || '';
        if (/^https?:/i.test(href)) { out += '\\href{' + href.replace(/([%#{}\\])/g, '\\$1') + '}{' + inlineTex(el, ctx) + '}'; ctx.usedHref = true; }
        else out += inlineTex(el, ctx);
        break;
      }
      default: out += inlineTex(el, ctx);
    }
  }
  return out;
}

function widthOpt(img) {
  const m = (img && img.getAttribute('style') || '').match(/width:\s*(\d+)%/);
  if (m) return '[width=' + (Math.max(1, Math.min(100, +m[1])) / 100).toFixed(2) + '\\linewidth]';
  const px = (img && img.getAttribute('style') || '').match(/width:\s*(\d+)px/);
  if (px) return '[width=' + px[1] + 'px]';
  return '[width=\\linewidth]';
}

/* ---- block walker ---- */
function walk(el, ctx, out) {
  if (!el || el.nodeType !== 1) return;
  const tag = el.tagName.toLowerCase(), cls = el.classList;
  if (cls.contains('bib-chip') || cls.contains('code-tools') || cls.contains('sr-only')) return;
  if (cls.contains('doc-header')) return;                          // title block handled from meta
  if (cls.contains('eq')) {                                        // display math
    const label = idToLabel(el.id);
    out.push('\\begin{equation}' + (label ? '\\label{' + label + '}' : '') + '\n' + cleanTex(el.getAttribute('data-tex')) + '\n\\end{equation}');
    return;
  }
  if (cls.contains('code-wrap') || tag === 'pre') {
    const code = el.querySelector('code') || el;
    const lang = (code.className.match(/language-(\w+)/) || [])[1];
    ctx.usedVerbatim = true;
    out.push('\\begin{verbatim}\n' + code.textContent.replace(/\n$/, '') + '\n\\end{verbatim}'
      + (lang ? '' : ''));                                         // lang hint dropped (verbatim has no highlighting)
    return;
  }
  if (cls.contains('markdown-alert')) {                            // callout → labeled quote
    let type = 'Note';
    for (const c of cls) { const m = c.match(/^markdown-alert-(\w+)$/); if (m) type = m[1][0].toUpperCase() + m[1].slice(1); }
    const paras = [];
    for (const ch of el.children) {
      if (ch.classList.contains('markdown-alert-title')) continue;
      const sub = []; walk(ch, ctx, sub); paras.push(...sub);
    }
    out.push('\\begin{quote}\n\\textbf{' + type + '.} ' + paras.join('\n\n') + '\n\\end{quote}');
    return;
  }
  if (cls.contains('references') || cls.contains('footnotes')) {   // rendered lists we re-emit natively elsewhere
    // footnotes already emitted inline via <sup>; a rendered references section
    // is dropped (LaTeX builds its own from \cite + the user's .bib).
    return;
  }
  if (cls.contains('toc')) return;                                 // \tableofcontents is the user's call

  switch (tag) {
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
      out.push('\\' + HEAD[tag] + '{' + inlineTex(el, ctx) + '}'); return;
    case 'p': {
      const t = inlineTex(el, ctx);                              // <sup> footnotes handled in inlineTex
      if (t.trim()) out.push(t);
      return;
    }
    case 'ul': case 'ol': out.push(listTex(el, ctx)); return;
    case 'blockquote': {
      const sub = []; for (const ch of el.children) walk(ch, ctx, sub);
      out.push('\\begin{quote}\n' + sub.join('\n\n') + '\n\\end{quote}'); return;
    }
    case 'table': out.push(tableTex(el, ctx)); return;
    case 'figure': {
      const img = el.querySelector('img');
      const cap = el.querySelector('figcaption');
      const capText = cap ? inlineTex(stripFigNo(cap), ctx).trim() : '';
      const label = idToLabel(el.id);
      // an unresolved project image has no live src — its authored relative
      // path survives in the data-local-src stash and IS the right
      // \includegraphics argument (a .tex compiled next to the project)
      const src = img ? (img.getAttribute('src') || img.getAttribute('data-local-src')
        || img.getAttribute('data-remote-src') || 'image') : 'image';
      ctx.usedGraphics = true;
      out.push('\\begin{figure}[htbp]\n\\centering\n\\includegraphics' + widthOpt(img) + '{' + texImagePath(src, ctx) + '}\n'
        + (capText ? '\\caption{' + capText + '}\n' : '') + (label ? '\\label{' + label + '}\n' : '') + '\\end{figure}');
      return;
    }
    case 'hr': out.push('\\begin{center}\\rule{0.5\\linewidth}{0.4pt}\\end{center}'); return;
    case 'section': case 'div': case 'article': case 'main':
      for (const ch of el.children) walk(ch, ctx, out); return;
    default: {
      const t = inlineTex(el, ctx); if (t.trim()) out.push(t);
    }
  }
}

/* figcaption starts with a "Figure N." span we don't want in the \caption. */
function stripFigNo(cap) {
  const clone = cap.cloneNode(true);
  const no = clone.querySelector('.fig-no'); if (no) no.remove();
  return clone;
}
/* data: URIs can't live in a .tex — replace with a referenced filename and
   collect it so the UI can warn. http(s) and plain paths pass through. */
/* A footnote <li> body → inline LaTeX (its <p> children walked like any prose). */
function footnoteTex(li, ctx) {
  const ps = [...li.children].filter((c) => c.tagName === 'P');
  const parts = (ps.length ? ps : [li]).map((p) => inlineTex(p, ctx).trim()).filter(Boolean);
  return parts.join(' ');
}

function texImagePath(src, ctx) {
  if (/^data:/i.test(src)) { ctx.dataImages = (ctx.dataImages || 0) + 1; return 'image-' + ctx.dataImages + '.png'; }
  return src.replace(/([%#{}\\])/g, '\\$1');
}

function listTex(el, ctx, depth = 0) {
  const env = el.tagName.toLowerCase() === 'ol' ? 'enumerate' : 'itemize';
  const lines = ['\\begin{' + env + '}'];
  for (const li of el.children) {
    if (li.tagName !== 'LI') continue;
    let item = '';
    for (const n of li.childNodes) {
      if (n.nodeType === 1 && (n.tagName === 'UL' || n.tagName === 'OL')) continue;
      if (n.nodeType === 1) item += inlineTex(n, ctx);
      else if (n.nodeType === 3) item += escapeText(n.textContent);
    }
    lines.push('  \\item ' + item.trim());
    for (const n of li.children) if (n.tagName === 'UL' || n.tagName === 'OL') lines.push(listTex(n, ctx, depth + 1));
  }
  lines.push('\\end{' + env + '}');
  return lines.join('\n');
}

function tableTex(el, ctx) {
  const rows = [];
  let ncol = 0;
  for (const tr of el.querySelectorAll('tr')) {
    const cells = [...tr.children].filter((c) => c.nodeType === 1).map((c) => inlineTex(c, ctx).trim());
    ncol = Math.max(ncol, cells.length);
    rows.push({ header: !!tr.closest('thead'), cells });
  }
  if (!rows.length) return '';
  ctx.usedTables = true;
  const spec = 'l'.repeat(ncol) || 'l';
  const lines = ['\\begin{table}[htbp]', '\\centering', '\\begin{tabular}{' + spec + '}', '\\toprule'];
  rows.forEach((r, i) => {
    lines.push(r.cells.join(' & ') + ' \\\\');
    if (r.header && (rows[i + 1] && !rows[i + 1].header)) lines.push('\\midrule');
  });
  lines.push('\\bottomrule', '\\end{tabular}', '\\end{table}');
  return lines.join('\n');
}

/* ---- public API ---- */
export function buildLatex(container, meta = {}) {
  const ctx = {
    footnotes: {}, usedGraphics: false, usedTables: false, usedVerbatim: false,
    usedHref: false, usedCite: false, usedStrike: false, dataImages: 0,
  };
  // collect footnote bodies first (referenced by <sup> in prose) — kept as
  // ELEMENTS and rendered through inlineTex at the use site: .textContent
  // would concatenate KaTeX's parallel renderings of every equation (MathML
  // text + raw TeX + HTML layout → "E=mc2E=mc^2E=mc2") and drop formatting
  const fnSection = container.querySelector('.footnotes');
  if (fnSection) {
    for (const li of fnSection.querySelectorAll('ol > li')) {
      const clone = li.cloneNode(true);
      for (const b of clone.querySelectorAll('[data-footnote-backref]')) b.remove();
      if (li.id) ctx.footnotes[li.id] = clone;
    }
  }

  const body = [];
  for (const el of [...container.children]) walk(el, ctx, body);

  const pkgs = [
    '\\usepackage[utf8]{inputenc}', '\\usepackage[T1]{fontenc}', '\\usepackage{amsmath,amssymb}',
  ];
  if (ctx.usedGraphics) pkgs.push('\\usepackage{graphicx}');
  if (ctx.usedTables) pkgs.push('\\usepackage{longtable,booktabs,array}');
  if (ctx.usedStrike) pkgs.push('\\usepackage[normalem]{ulem}');
  pkgs.push('\\usepackage{hyperref}');                              // always, last

  const authors = (meta && Array.isArray(meta.authors)) ? meta.authors.join(' \\and ') : (meta && meta.author) || '';
  const preambleMeta = [];
  if (meta && meta.title) preambleMeta.push('\\title{' + escapeText(meta.title) + '}');
  if (authors) preambleMeta.push('\\author{' + escapeText(authors) + '}');
  if (meta && meta.date) preambleMeta.push('\\date{' + escapeText(meta.date) + '}');

  const doc = [
    '% Generated by Colophon — a starting point for editing, not a submission-ready file.',
    '% Per-journal classes (acmart/elsarticle/revtex/IEEEtran) and the bibliography',
    '% are intentionally left to you; \\cite keys assume your own .bib + \\bibliography.',
    '\\documentclass[11pt]{article}',
    ...pkgs,
    ...preambleMeta,
    '',
    '\\begin{document}',
    ...(preambleMeta.length ? ['\\maketitle', ''] : []),
    body.join('\n\n'),
    '',
    '\\end{document}',
    '',
  ].join('\n');

  return { tex: doc, notes: dataNotes(ctx) };
}

function dataNotes(ctx) {
  const notes = [];
  if (ctx.dataImages) notes.push(ctx.dataImages + ' embedded image' + (ctx.dataImages > 1 ? 's' : '') + ' referenced as image-N.png (save them alongside the .tex)');
  if (ctx.usedCite) notes.push('\\cite keys need your own .bib + a \\bibliography line');
  return notes;
}

export default buildLatex;
