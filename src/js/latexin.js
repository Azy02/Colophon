/* Colophon — LaTeX-fragment import (pure, testable).

   convertLatex(src) → { text, notes, confidence } turns a pasted LaTeX
   FRAGMENT or full document into Colophon-flavored Markdown. It is a
   *bridge for prose*, deliberately not a TeX engine: structure commands are
   translated, math CONTENT is passed through untouched for KaTeX (only the
   delimiters are canonicalized — \(..\)→$..$, \[..\]→$$..$$, and
   align/equation/gather wrappers rewritten to the KaTeX-safe forms; see
   canonMath), and anything unrecognized is left verbatim and REPORTED
   rather than guessed at.

   Conservatism rules: never invent content, never drop content silently
   (dropped preamble is reported), idempotent-by-vanishing (output contains
   no LaTeX structure commands, so a second pass no-ops). */

const S_OPEN = String.fromCharCode(0xE020);   // PUA sentinels
const S_CLOSE = String.fromCharCode(0xE021);
const SENTINEL_RE = new RegExp('[' + S_OPEN + S_CLOSE + ']', 'g');
const tok = (i) => S_OPEN + i + S_CLOSE;
const TOK_RE = new RegExp(S_OPEN + '(\\d+)' + S_CLOSE, 'g');

/** Cheap detector for "this paste is LaTeX, offer to convert" UI hooks. */
export function looksLikeLatex(src) {
  const s = String(src ?? '');
  if (/\\documentclass|\\begin\{document\}|\\usepackage/.test(s)) return true;
  const structural = (s.match(/\\(section|subsection|chapter|textbf|textit|emph|item|begin|cite|includegraphics|footnote)\b/g) || []).length;
  return structural >= 3;
}

/* Balanced-brace argument reader: returns [content, endIndex] for the group
   starting at src[i] === '{', or null. Handles nesting and \{ escapes. */
function readGroup(src, i) {
  if (src[i] !== '{') return null;
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') { j++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return [src.slice(i + 1, j), j + 1]; }
  }
  return null;
}

/* Replace every \cmd{arg} (balanced) via fn(arg) — regex alone can't nest. */
function replaceCommand(src, cmd, fn) {
  let out = '', i = 0, count = 0;
  const needle = '\\' + cmd;
  for (;;) {
    const at = src.indexOf(needle + '{', i);
    if (at === -1) { out += src.slice(i); break; }
    // reject longer command names sharing the prefix (\textbf vs \textbfx)
    const g = readGroup(src, at + needle.length);
    if (!g) { out += src.slice(i, at + needle.length); i = at + needle.length; continue; }
    out += src.slice(i, at) + fn(g[0]);
    i = g[1]; count++;
  }
  return { text: out, count };
}

/* ---------- protection: verbatim + math must survive untouched ---------- */
function protect(src, store) {
  let text = src;
  // verbatim-family environments → fenced code
  text = text.replace(/\\begin\{(verbatim|lstlisting|minted)\}(\[[^\]]*\])?(\{[^}]*\})?\n?([\s\S]*?)\\end\{\1\}/g,
    (m, env, opts, lang, body) => {
      const info = env === 'minted' ? String(lang || '').replace(/[{}]/g, '')
        : (String(opts || '').match(/language=([A-Za-z0-9+#-]+)/) || [, ''])[1];
      store.push('```' + (info || '') + '\n' + body.replace(/\n$/, '') + '\n```');
      return '\n' + tok(store.length - 1) + '\n';
    });
  // \verb|x| inline
  text = text.replace(/\\verb(.)((?:(?!\1).)*)\1/g, (m, d, body) => {
    store.push('`' + body + '`');
    return tok(store.length - 1);
  });
  // math, outermost first: $$…$$, \[…\], display envs, then $…$, \(…\)
  const mathPatterns = [
    /\$\$[\s\S]*?\$\$/g,
    /\\\[[\s\S]*?\\\]/g,
    /\\begin\{(equation|align|gather|multline|eqnarray)(\*?)\}[\s\S]*?\\end\{\1\2\}/g,
    /(?<!\\)\$(?:\\.|[^$\\])+\$/g,
    /\\\([\s\S]*?\\\)/g,
  ];
  for (const re of mathPatterns) {
    text = text.replace(re, (m, ...rest) => {
      const [at, s] = rest.slice(-2);                 // capture groups vary per pattern
      let canon = canonMath(m);
      // the renderer's currency guard refuses a closing $ followed by a digit
      // ("$5 and $10" stays prose) — \(x\)5 must keep its \(..\) form, which
      // the pipeline renders directly, instead of becoming dead "$x$5" text
      if (canon.startsWith('$') && !canon.startsWith('$$') && /\d/.test(s[at + m.length] || '')) canon = m;
      store.push(canon);
      const t = tok(store.length - 1);
      // a $$ block is only a display BLOCK if blank lines isolate it — mid-
      // paragraph it splits the <p> and orphans the trailing prose as a bare
      // text node (the removed cleanup engine used to force this isolation;
      // the final \n{3,}→\n\n collapse keeps a second pass idempotent)
      return canon.startsWith('$$') ? '\n\n' + t + '\n\n' : t;
    });
  }
  return text;
}

/* Canonical Colophon delimiters for the math the patterns above captured.
   Math CONTENT stays byte-identical; only the wrapper changes:
     \[ … \]                  → $$ … $$ (own lines)
     \( … \)                  → $ … $
     \begin{equation} … \end  → $$ … $$ (wrapper dropped — KaTeX has no {equation})
     \begin{align} … \end     → $$ \begin{aligned} … \end{aligned} $$
     \begin{gather} … \end    → $$ \begin{gathered} … \end{gathered} $$
   multline/eqnarray have no KaTeX equivalent — kept verbatim so the failure
   is visible and reported, never silently mangled. $…$/$$…$$ pass through. */
function canonMath(m) {
  const display = (inner) => '$$\n' + inner.replace(/^\s+|\s+$/g, '') + '\n$$';
  if (m.startsWith('\\[')) return display(m.slice(2, -2));
  if (m.startsWith('\\(')) return '$' + m.slice(2, -2).trim() + '$';
  const env = /^\\begin\{(equation|align|gather)(\*?)\}/.exec(m);
  if (env) {
    const inner = m.slice(env[0].length, m.length - ('\\end{' + env[1] + env[2] + '}').length);
    if (env[1] === 'equation') return display(inner);
    const karg = env[1] === 'align' ? 'aligned' : 'gathered';
    return display('\\begin{' + karg + '}' + inner.replace(/\s+$/, '') + '\n\\end{' + karg + '}');
  }
  return m;
}
/* Stored entries can themselves contain earlier tokens (e.g. a $$…$$ captured
   by pattern 1 sitting inside a \[…\] captured by pattern 2), so expand until
   stable. Terminates: a stored string only references strictly earlier store
   indices (input sentinels are stripped at entry), so expansion is a DAG. */
const restore = (text, store) => {
  let prev;
  do { prev = text; text = text.replace(TOK_RE, (m, i) => store[+i] ?? m); } while (text !== prev);
  return text;
};

/* ---------- main ---------- */
export function convertLatex(src, opts = {}) {
  const notes = [];
  const note = (what, count = 1) => {
    const hit = notes.find((n) => n.what === what);
    if (hit) hit.count += count; else notes.push({ what, count });
  };
  let text = String(src ?? '').replace(SENTINEL_RE, '').replace(/\r\n?/g, '\n');
  const store = [];

  /* --- document wrapper & preamble --- */
  const meta = {};
  const grab = (cmd) => {
    const r = replaceCommand(text, cmd, (arg) => { meta[cmd] = meta[cmd] ?? arg.trim(); return ''; });
    text = r.text;
  };
  grab('title'); grab('author'); grab('date');
  const bodyM = text.match(/\\begin\{document\}([\s\S]*?)\\end\{document\}/);
  if (bodyM) {
    const preambleLines = text.slice(0, bodyM.index).split('\n').filter((l) => l.trim()).length;
    if (preambleLines) note('preamble lines dropped', preambleLines);
    text = bodyM[1];
  }

  /* --- protect code + math before any prose surgery --- */
  text = protect(text, store);

  /* --- comments (after protection so % inside code/math survives) --- */
  text = text.replace(/(^|[^\\])%[^\n]*/g, (m, pre) => { note('comments stripped'); return pre; });

  /* --- footnotes: hoist to markdown reference style. The definitions are
     appended to `text` IMMEDIATELY so every later pass — inline styles,
     citations, char-level LaTeXisms, the leftovers count, and above all the
     math-token restore — processes them like any other prose. (They used to
     sit in a side array appended after restore(): math inside a \footnote
     came out as raw sentinel characters, i.e. silent equation loss.) --- */
  const footnotes = [];
  for (;;) {
    const r = replaceCommand(text, 'footnote', (arg) => {
      footnotes.push(arg.trim().replace(/\s*\n\s*/g, ' '));
      return '[^lx' + footnotes.length + ']';
    });
    text = r.text;
    if (!r.count) break;
    note('footnotes converted', r.count);
  }
  if (footnotes.length) {
    text += '\n\n' + footnotes.map((f, i) => '[^lx' + (i + 1) + ']: ' + f).join('\n') + '\n';
  }

  /* --- figures --- */
  text = text.replace(/\\begin\{figure\}(\[[^\]]*\])?([\s\S]*?)\\end\{figure\}/g, (m, pos, body) => {
    const img = body.match(/\\includegraphics\s*(\[[^\]]*\])?\s*\{([^}]*)\}/);
    const cap = (() => { let c = null; replaceCommand(body, 'caption', (a) => { c = c ?? a.trim(); return ''; }); return c; })();
    const lab = (body.match(/\\label\s*\{([^}]*)\}/) || [])[1];
    if (!img) { note('figure without \\includegraphics left as-is'); return m; }
    note('figures converted');
    const id = lab ? ' {#' + (lab.startsWith('fig') ? lab : 'fig:' + lab) + '}' : '';
    return '\n![' + (cap || '') + '](' + img[2] + ')' + id + '\n';
  });
  // bare includegraphics outside a figure env
  text = text.replace(/\\includegraphics\s*(\[[^\]]*\])?\s*\{([^}]*)\}/g, (m, o, path) => {
    note('bare images converted');
    return '![](' + path + ')';
  });

  /* --- simple tabular → pipe table --- */
  // table-wrapped first (carries a caption); then any bare tabular that remains
  // (very common in informal LaTeX / LLM output — must convert here so the
  // char-level pass below doesn't shred its \\ row breaks and \& into garbage).
  text = text.replace(/\\begin\{table\}(\[[^\]]*\])?([\s\S]*?)\\end\{table\}/g, (m, pos, body) => {
    const inner = body.match(/\\begin\{tabular\}\{[^}]*\}([\s\S]*?)\\end\{tabular\}/);
    if (!inner) { note('table without tabular left as-is'); return m; }
    const cap = (() => { let c = null; replaceCommand(body, 'caption', (a) => { c = c ?? a.trim(); return ''; }); return c; })();
    const md = tabularToPipe(inner[1], note, store);
    if (!md) return m;
    return '\n' + md + '\n' + (cap ? '\nTable: ' + cap + '\n' : '');
  });
  text = text.replace(/\\begin\{tabular\}\{[^}]*\}([\s\S]*?)\\end\{tabular\}/g, (m, inner) => {
    const md = tabularToPipe(inner, note, store);
    return md ? '\n' + md + '\n' : m;
  });

  /* --- sectioning --- */
  const SECTIONS = [['chapter', '#'], ['section', '##'], ['subsection', '###'], ['subsubsection', '####'], ['paragraph', '#####']];
  for (const [cmd, hashes] of SECTIONS) {
    for (const variant of [cmd + '*', cmd]) {
      for (;;) {
        const r = replaceCommand(text, variant, (arg) => '\n' + hashes + ' ' + arg.trim() + '\n');
        text = r.text;
        if (r.count) note('headings converted', r.count);
        if (!r.count) break;
      }
    }
  }

  /* --- inline styles (repeat until stable for nesting) --- */
  const INLINE = [
    ['textbf', (a) => '**' + a + '**'], ['textit', (a) => '*' + a + '*'],
    ['emph', (a) => '*' + a + '*'], ['texttt', (a) => '`' + a + '`'],
    ['textsc', (a) => a], ['underline', (a) => '*' + a + '*'], ['uline', (a) => '*' + a + '*'],
    ['mbox', (a) => a], ['textnormal', (a) => a], ['textrm', (a) => a],
  ];
  for (let pass = 0; pass < 4; pass++) {
    let changed = 0;
    for (const [cmd, fn] of INLINE) {
      const r = replaceCommand(text, cmd, fn);
      if (r.count) { text = r.text; changed += r.count; note('inline styles converted', r.count); }
    }
    if (!changed) break;
  }

  /* --- links & citations & refs --- */
  { const r = replaceCommand(text, 'url', (a) => '<' + a + '>'); if (r.count) { text = r.text; note('links converted', r.count); } }
  text = text.replace(/\\href\s*\{([^}]*)\}\s*\{([^}]*)\}/g, (m, url, label) => { note('links converted'); return '[' + label + '](' + url + ')'; });
  text = text.replace(/\\(?:cite|citep|citet|parencite|textcite)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g, (m, keys) => {
    note('citations converted');
    return keys.split(',').map((k) => '[@' + k.trim() + ']').join(' ');
  });
  // \ref/\eqref pass through — Colophon's pipeline resolves them natively — but a
  // LaTeX author writes "Figure~\ref{fig:x}", whereas Colophon renders a fig/tbl
  // \ref as the full "Figure N"/"Table N". Drop the now-redundant leading word so
  // the import doesn't read "Figure Figure 1". (Runs before ~ → space below.)
  text = text.replace(/\b(?:Figures?|Figs?\.?|Tables?|Tabs?\.?)[~ ]+(\\ref\s*\{\s*(?:fig|tbl|tab|table)[:.])/gi,
    (m, ref) => { note('redundant figure/table word dropped before \\ref'); return ref; });

  /* --- lists (line-based, handles nesting by env depth) --- */
  text = convertLists(text, note);

  /* --- quotes & misc block commands --- */
  text = text.replace(/\\begin\{(quote|quotation)\}([\s\S]*?)\\end\{\1\}/g, (m, env, body) => {
    note('quotes converted');
    return '\n' + body.trim().split('\n').map((l) => '> ' + l.trim()).join('\n') + '\n';
  });
  text = text.replace(/\\begin\{(center|flushleft|flushright|abstract)\}([\s\S]*?)\\end\{\1\}/g, (m, env, body) => {
    note(env === 'abstract' ? 'abstract unwrapped' : 'alignment environment unwrapped');
    return '\n' + body.trim() + '\n';
  });
  text = text.replace(/\\(maketitle|tableofcontents|newpage|clearpage|centering|noindent|listoffigures|listoftables)\b\*?/g, (m, cmd) => {
    if (cmd === 'tableofcontents') { note('[TOC] inserted'); return '\n[TOC]\n'; }
    note('layout commands dropped');
    return '';
  });

  /* --- character-level LaTeXisms --- */
  text = text.replace(/(?<!\\)~/g, ' ');                      // non-breaking tie
  text = text.replace(/``/g, '“').replace(/''/g, '”');        // TeX quotes → curly
  text = text.replace(/(?<![-\\])---(?!-)/g, '—').replace(/(?<![-\\])--(?!-)/g, '–');
  text = text.replace(/\\([%&#_])/g, '$1');                   // unescape specials ($ stays escaped for the math pipeline)
  text = text.replace(/\\\\\s*$/gm, '');                      // trailing forced breaks
  text = text.replace(/\\(ldots|dots)\b/g, '…');
  text = text.replace(/\\(LaTeX|TeX)\b(\{\})?/g, '$1');       // logo macros → plain words

  /* --- leftovers: count, don't guess. Counted BEFORE math/code tokens are
     restored: commands inside $…$ / equation envs are passed through for
     KaTeX by design and must not drag confidence down — only unconverted
     PROSE commands signal a lossy import. --- */
  const leftovers = (text.match(/\\[a-zA-Z]+/g) || [])
    .filter((c) => !/^\\(ref|eqref|label|cite|begin|end|left|right|frac|sum|int|text|mathrm|alpha|beta|gamma|sigma|infty|times|cdot|ce|pu)/.test(c));
  if (leftovers.length) note('unrecognized commands left verbatim', leftovers.length);

  /* --- front matter (footnote definitions already live in `text`) --- */
  text = restore(text, store);
  if (meta.title) {
    // grabbed before the char pass ran: strip logo macros AND unescape the
    // same specials the body gets (\& \% \# \_)
    const unTexify = (s) => String(s).replace(/\\(LaTeX|TeX)\b(\{\})?/g, '$1').replace(/\\([%&#_])/g, '$1');
    const fm = ['---', 'title: ' + unTexify(meta.title)];
    if (meta.author) fm.push('author: ' + unTexify(meta.author).replace(/\\and\b/g, ',').replace(/\s+,/g, ','));
    if (meta.date && !/\\today/.test(meta.date)) fm.push('date: ' + meta.date);
    fm.push('---', '');
    text = fm.join('\n') + text;
    note('front matter extracted');
  }

  text = text.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n*$/, '\n');
  const confidence = leftovers.length > 20 ? 'low' : leftovers.length > 5 ? 'medium' : 'high';
  return { text, notes, confidence };
}

/* A `tabular` body → a GFM pipe table string, or null if it can't be handled
   safely (complex spans, empty). Shared by the table-wrapped and bare paths so
   both convert identically instead of one silently getting mangled downstream.
   The delimiter row is a protection token (store), NOT literal "---": the
   character-level pass below turns a bare "---" into an em-dash, which would
   destroy the row GFM needs to recognize a table. Cell prose is left un-tokenized
   so it still gets the dash/quote/tie conversions. */
function tabularToPipe(inner, note, store) {
  if (/\\multicolumn|\\multirow/.test(inner)) { note('complex table left as-is (multicolumn/multirow)'); return null; }
  const rows = inner.split('\\\\').map((r) => r.replace(/\\(hline|toprule|midrule|bottomrule)/g, '').trim()).filter(Boolean);
  if (!rows.length) { note('empty table left as-is'); return null; }
  const cells = rows.map((r) => r.split(/(?<!\\)&/).map((c) => c.replace(/\\&/g, '&').trim()));
  const width = Math.max(...cells.map((r) => r.length));
  const line = (r) => '| ' + Array.from({ length: width }, (_, i) => r[i] || '').join(' | ') + ' |';
  store.push('|' + Array(width).fill(' --- ').join('|') + '|');
  note('tables converted');
  return [line(cells[0]), tok(store.length - 1), ...cells.slice(1).map(line)].join('\n');
}

/* itemize/enumerate/description with nesting. Line-oriented: split items on
   \item at each env level; indent nested envs by two spaces per depth. */
function convertLists(text, note) {
  for (let guard = 0; guard < 12; guard++) {
    // innermost list envs first (no nested \begin{itemize|enumerate|description} inside)
    const re = /\\begin\{(itemize|enumerate|description)\}((?:(?!\\begin\{(?:itemize|enumerate|description)\})[\s\S])*?)\\end\{\1\}/;
    const m = re.exec(text);
    if (!m) break;
    const [whole, env, body] = m;
    const items = body.split(/\\item\b/).slice(1);
    const lines = items.map((it, i) => {
      let s = it.trim();
      let label = null;
      const lm = s.match(/^\[([^\]]*)\]\s*/);
      if (lm) { label = lm[1]; s = s.slice(lm[0].length); }
      s = s.replace(/\n\s*/g, '\n  ');                       // continuation indent
      if (env === 'enumerate') return (i + 1) + '. ' + s;
      if (env === 'description') return '- **' + (label || '') + '** ' + s;
      return '- ' + (label ? label + ' ' : '') + s;
    });
    note('lists converted');
    text = text.slice(0, m.index) + '\n' + lines.join('\n') + '\n' + text.slice(m.index + whole.length);
  }
  return text;
}

export default convertLatex;
