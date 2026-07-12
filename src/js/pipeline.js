/* ============================================================================
   The render pipeline: Markdown + math + citations → sanitized HTML.

   Order of operations (the protection dance):
     1. strip PUA sentinels from input (forgery guard)
     2. front matter off the top
     3. extract fenced code (``` and ~~~, line-scanner)  → C tokens
        (```bibtex fences are diverted to the bibliography)
     4. extract inline code (`…`, any backtick run)      → c tokens
     5. hide \$ escapes
     6. extract display math  $$…$$ | \[…\]  (one pass, source order) → D
     7. extract inline math   \(…\) | $…$   (one pass, strict $ rules) → I
     8. extract citations     [@key; @key] | \cite{…}    → X
     9. plan equation numbering; turn \eqref/\ref into E/F tokens
    10. marked (GFM + footnotes + alerts + heading ids)
    11. restore tokens: KaTeX, highlight.js, citation links, eqrefs
    12. title block + references section
    13. sanitize (DOMPurify — the only gate to innerHTML)
   Pure with respect to the DOM except sanitize(); fully testable in Node.
   ============================================================================ */

import { Marked } from 'marked';
import markedFootnote from 'marked-footnote';
import markedAlert from 'marked-alert';
import { gfmHeadingId, getHeadingList } from 'marked-gfm-heading-id';
import katex from 'katex';
import 'katex/contrib/mhchem';       // registers \ce / \pu chemistry macros
import hljs from 'highlight.js/lib/common';
import { sanitize } from './sanitize.js';
import { parseFrontMatter } from './frontmatter.js';
import { planEquations, resolveEqrefsInTex } from './mathpass.js';
import { parseBibtex, citeLabel, formatReference, sortKey } from './bibtex.js';

const OPEN = '', CLOSE = '', ESC_DOLLAR = '';
const tokRe = (types) => new RegExp(OPEN + '([' + types + '])(\\d+)' + CLOSE, 'g');

export const escapeHtml = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const escapeAttr = t => escapeHtml(t).replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* ---------- marked singleton ---------- */
const marked = new Marked({ gfm: true, breaks: false });
/* 'h-' prefix keeps heading anchors clear of DOMPurify's DOM-clobbering
   protection (an id like "title" would otherwise be stripped). */
marked.use(gfmHeadingId({ prefix: 'h-' }), markedFootnote(), markedAlert());

/* ---------- fence extraction (line scanner: ``` and ~~~, unclosed → EOF) ---------- */
function extractFences(src, store) {
  const lines = src.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^( {0,3})(`{3,}|~{3,})[ \t]*(\S*)[ \t]*$/);
    // opening fence: ``` may not contain ` in info string (CommonMark)
    if (m && !(m[2][0] === '`' && m[3].includes('`'))) {
      const [, , fence, info] = m;
      const closeRe = new RegExp('^ {0,3}' + fence[0] + '{' + fence.length + ',}[ \\t]*$');
      let j = i + 1;
      while (j < lines.length && !closeRe.test(lines[j])) j++;
      const code = lines.slice(i + 1, j).join('\n');
      store.C.push({ lang: info.trim().toLowerCase(), code });
      out.push(OPEN + 'C' + (store.C.length - 1) + CLOSE);
      i = (j < lines.length) ? j + 1 : j;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join('\n');
}

/* ---------- inline code: any same-length backtick run, no blank line inside ---------- */
function extractInlineCode(s, store) {
  return s.replace(/(`+)([\s\S]+?)\1/g, (m, ticks, code) => {
    if (/\n[ \t]*\n/.test(code)) return m;                       // spans a blank line → not code
    store.c.push(code.replace(/^ (.*) $/s, '$1'));               // CommonMark single-space trim
    return OPEN + 'c' + (store.c.length - 1) + CLOSE;
  });
}

/* ---------- math extraction ---------- */
const DISPLAY_RE = /\$\$([\s\S]+?)\$\$|(?<!\\)\\\[([\s\S]+?)\\\]/g;
// $…$ rules: opens before non-space/non-$; closes after non-space/non-backslash;
// closing $ not followed by a digit (kills "$5 and $10"); may wrap ONE line.
const INLINE_RE = /(?<!\\)\\\(([\s\S]+?)\\\)|\$(?!\s|\$)((?:[^$\n]|\n(?![ \t]*\n))+?)(?<![\s\\])\$(?!\d)/g;

function extractMath(s, store) {
  s = s.replace(DISPLAY_RE, (m, a, b) => {
    store.D.push((a ?? b).trim());
    return OPEN + 'D' + (store.D.length - 1) + CLOSE;
  });
  s = s.replace(INLINE_RE, (m, a, b) => {
    store.I.push((a ?? b).replace(/\s+/g, ' ').trim());
    return OPEN + 'I' + (store.I.length - 1) + CLOSE;
  });
  return s;
}

/* ---------- citations: [@a; @b] and \cite{a,b} in one source-ordered pass ---------- */
const CITE_RE = /\[@([^\[\]]+?)\]|\\cite[tp]?\*?\s*\{([^{}]+)\}/g;
function extractCitations(s, store) {
  return s.replace(CITE_RE, (m, brack, curly) => {
    const raw = brack ?? curly;
    const keys = raw.split(/[;,]/).map(k => k.trim().replace(/^@/, '')).filter(Boolean);
    if (!keys.length) return m;
    store.X.push({ keys, raw: m });
    return OPEN + 'X' + (store.X.length - 1) + CLOSE;
  });
}

/* ---------- \eqref / \ref in prose ---------- */
function extractRefs(s, store, eqLabels) {
  return s.replace(/\\(eqref|ref)\s*\{([^{}]+)\}/g, (m, kind, label) => {
    label = label.trim();
    if (eqLabels.has(label)) {
      store.E.push({ label, paren: kind === 'eqref' });
      return OPEN + 'E' + (store.E.length - 1) + CLOSE;
    }
    if (/^(fig|tbl|table|sec)[:.]/.test(label)) {
      store.F.push({ target: label });
      return OPEN + 'F' + (store.F.length - 1) + CLOSE;
    }
    store.E.push({ label, paren: kind === 'eqref' });             // unknown → rendered (??)
    return OPEN + 'E' + (store.E.length - 1) + CLOSE;
  });
}

/* ---------- KaTeX ---------- */
const KATEX_OPTS = { throwOnError: false, strict: 'ignore', trust: false };
function renderMath(tex, display, eqLabels) {
  tex = tex.replace(new RegExp(ESC_DOLLAR, 'g'), '\\$');
  if (eqLabels) tex = resolveEqrefsInTex(tex, eqLabels);
  try {
    return katex.renderToString(tex, { ...KATEX_OPTS, displayMode: display });
  } catch (e) {
    const d = display ? '$$' : '$';
    return '<code class="math-err" title="' + escapeAttr(String(e.message || e)) + '">'
      + escapeHtml(d + tex + d) + '</code>';
  }
}

/* ---------- highlight.js ---------- */
const LANG_ALIASES = { 'c++': 'cpp', 'objective-c': 'objectivec', sh: 'bash', shell: 'bash', zsh: 'bash',
  py: 'python', js: 'javascript', ts: 'typescript', yml: 'yaml', tex: 'latex', text: 'plaintext', txt: 'plaintext' };
function renderCode(lang, code) {
  const norm = LANG_ALIASES[lang] || lang;
  let body, cls = 'hljs';
  if (norm && hljs.getLanguage(norm)) {
    try { body = hljs.highlight(code, { language: norm, ignoreIllegals: true }).value; cls += ' language-' + norm; }
    catch { body = escapeHtml(code); }
  } else {
    body = escapeHtml(code);
    if (norm) cls += ' language-' + norm;
  }
  return '<div class="code-wrap"' + (lang ? ' data-lang="' + escapeAttr(lang) + '"' : '') + '>'
    + '<pre><code class="' + cls + '">' + body + '\n</code></pre></div>';
}

/* ---------- main entry ---------- */
/**
 * @param {string} src markdown source (may start with front matter)
 * @param {object} opts { numbering:'auto'|'all'|'none', citationStyle:'numeric'|'author-year',
 *                        externalBib:string|null, docName:string }
 * @returns {{ html, meta, outline, warnings, hasMermaid, hasMath, citeCount, eqCount }}
 */
export function render(src, opts = {}) {
  const warnings = [];
  src = String(src ?? '').replace(/[-]/g, '').replace(/\r\n?/g, '\n');

  const { meta, body } = parseFrontMatter(src);
  const numbering = meta.numberEquations === true ? 'all'
    : meta.numberEquations === false ? 'none'
    : (opts.numbering || 'auto');
  const citationStyle = meta.citationStyle === 'author-year' ? 'author-year'
    : meta.citationStyle === 'numeric' ? 'numeric'
    : (opts.citationStyle || 'numeric');

  const store = { C: [], c: [], D: [], I: [], X: [], E: [], F: [] };
  let s = extractFences(body, store);
  s = extractInlineCode(s, store);
  s = s.replace(/\\\$/g, ESC_DOLLAR);
  s = extractMath(s, store);
  s = extractCitations(s, store);

  /* bibliography: external .bib + any ```bibtex fences */
  const bibParts = [];
  if (opts.externalBib) bibParts.push(opts.externalBib);
  for (const c of store.C) if (c.lang === 'bibtex' || c.lang === 'bib') bibParts.push(c.code);
  const bib = parseBibtex(bibParts.join('\n\n'));
  warnings.push(...bib.warnings);

  /* equation planning */
  const { plans, labels: eqLabels } = planEquations(store.D, numbering);
  s = extractRefs(s, store, eqLabels);

  /* citation numbering by first use */
  const citeNums = new Map();
  for (const x of store.X) for (const k of x.keys) {
    if (bib.entries.has(k) && !citeNums.has(k)) citeNums.set(k, citeNums.size + 1);
  }

  /* markdown */
  let html = marked.parse(s);
  const outline = getHeadingList().map(h => ({ level: h.level, text: h.text, id: h.id }));

  /* Block tokens (display math, fences) got wrapped in <p>…</p> by marked.
     A paragraph that IS the token unwraps; a token SHARING its paragraph with
     prose splits it — the token restores to a block <div>, and a block inside
     <p> makes the HTML parser auto-close the paragraph, orphaning the trailing
     prose as a bare text node (which the DOCX/LaTeX exporters — element-only
     walkers — would then silently drop). */
  const blockTok = new RegExp(OPEN + '[DC]\\d+' + CLOSE);
  const blockTokSplit = new RegExp('(' + OPEN + '[DC]\\d+' + CLOSE + ')');
  html = html.replace(/<p>([\s\S]*?)<\/p>/g, (m, inner) => {
    if (!blockTok.test(inner)) return m;
    return inner.split(blockTokSplit)
      .filter((part) => part.trim())
      .map((part) => blockTok.test(part) ? part : '<p>' + part + '</p>')
      .join('');
  });

  /* restore everything */
  html = html.replace(tokRe('DICcXEF'), (m, type, idx) => {
    const i = +idx;
    switch (type) {
      case 'D': {
        const plan = plans[i];
        const inner = renderMath(plan.tex, true, eqLabels);
        return '<div class="eq"' + (plan.id ? ' id="' + escapeAttr(plan.id) + '"' : '')
          + ' data-tex="' + escapeAttr(plan.tex) + '" data-display="1">' + inner + '</div>';
      }
      case 'I':
        return '<span class="imath" data-tex="' + escapeAttr(store.I[i]) + '">'
          + renderMath(store.I[i], false, eqLabels) + '</span>';
      case 'C': {
        const { lang, code } = store.C[i];
        if (lang === 'bibtex' || lang === 'bib') {
          const n = parseBibtex(code).entries.size;
          return '<div class="bib-chip">bibliography · ' + n + ' entr' + (n === 1 ? 'y' : 'ies') + '</div>';
        }
        return renderCode(lang, code);
      }
      case 'c':
        return '<code>' + escapeHtml(store.c[i]) + '</code>';
      case 'X': {
        const x = store.X[i];
        const parts = x.keys.map(k => {
          const entry = bib.entries.get(k);
          if (!entry) return '<span class="cite-unresolved" title="no BibTeX entry for @' + escapeAttr(k) + '">[@' + escapeHtml(k) + ']</span>';
          const label = citeLabel(entry, citationStyle, citeNums.get(k));
          return '<a class="cite" href="#ref-' + escapeAttr(k) + '">' + escapeHtml(label) + '</a>';
        });
        if (citationStyle === 'author-year' && x.keys.length > 1 && x.keys.every(k => bib.entries.has(k))) {
          const inner = x.keys.map(k =>
            '<a class="cite" href="#ref-' + escapeAttr(k) + '">'
            + escapeHtml(citeLabel(bib.entries.get(k), 'author-year', citeNums.get(k)).slice(1, -1)) + '</a>');
          return '(' + inner.join('; ') + ')';
        }
        return parts.join(citationStyle === 'numeric' ? '' : ' ');
      }
      case 'E': {
        const e = store.E[i];
        const hit = eqLabels.get(e.label);
        if (!hit) return '<span class="cite-unresolved" title="no equation labeled ' + escapeAttr(e.label) + '">(??)</span>';
        const text = e.paren ? '(' + hit.text + ')' : hit.text;
        return '<a class="eqref" href="#' + escapeAttr(hit.id) + '">' + escapeHtml(text) + '</a>';
      }
      case 'F': {
        const f = store.F[i];
        return '<span class="xref" data-xref="' + escapeAttr(f.target) + '">?</span>';
      }
    }
    return m;
  });
  html = html.replace(new RegExp(ESC_DOLLAR, 'g'), '$');

  /* references section */
  const usedKeys = [...citeNums.keys()];
  if (usedKeys.length) {
    const entries = usedKeys.map(k => bib.entries.get(k));
    if (citationStyle === 'author-year') entries.sort((a, b) => sortKey(a) < sortKey(b) ? -1 : 1);
    const items = entries.map(e =>
      '<li id="ref-' + escapeAttr(e.key) + '" class="ref-item">' + formatReference(e, citationStyle) + '</li>').join('\n');
    const list = citationStyle === 'numeric' ? '<ol>' + items + '</ol>' : '<ul class="ref-ay">' + items + '</ul>';
    const section = '<section class="references"><h2 id="references">References</h2>\n' + list + '</section>';
    if (/<p>\[\[references\]\]<\/p>/i.test(html)) html = html.replace(/<p>\[\[references\]\]<\/p>/i, section);
    else html += '\n' + section;
    outline.push({ level: 2, text: 'References', id: 'references' });
  }

  /* title block from front matter */
  let header = '';
  if (meta.title) {
    header += '<header class="doc-header"><h1 class="doc-title" id="doc-title">' + escapeHtml(String(meta.title)) + '</h1>';
    if (meta.subtitle) header += '<p class="doc-subtitle">' + escapeHtml(String(meta.subtitle)) + '</p>';
    const byline = [];
    if (meta.authors?.length) byline.push(meta.authors.map(escapeHtml).join(', '));
    if (meta.date) byline.push(escapeHtml(String(meta.date)));
    if (byline.length) header += '<p class="doc-byline">' + byline.join('<span class="sep">·</span>') + '</p>';
    if (meta.abstract) header += '<div class="doc-abstract"><span class="abs-label">Abstract.</span>' + escapeHtml(String(meta.abstract)) + '</div>';
    header += '</header>\n';
    if (meta.toc === true && !/\[TOC\]|\[\[toc\]\]/i.test(body)) header += '<p>[TOC]</p>\n';
  }
  html = header + html;

  return {
    html: sanitize(html),
    meta, outline, warnings,
    hasMermaid: store.C.some(c => c.lang === 'mermaid'),
    hasMath: store.D.length + store.I.length > 0,
    citeCount: usedKeys.length,
    eqCount: plans.filter(p => p.number !== null).length,
  };
}
