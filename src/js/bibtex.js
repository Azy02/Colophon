/* BibTeX parsing + two built-in citation styles (numeric, author-year).
   Pure module — no DOM. Full CSL is a v2 feature; this covers the 90% case of
   research notes. All formatter output is HTML-escaped here (defense in depth —
   the pipeline sanitizes again downstream). */

const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ---------- LaTeX-ism cleanup (subset that appears in real .bib files) ---------- */
const ACCENTS = {
  "\\'a":'á',"\\'e":'é',"\\'i":'í',"\\'o":'ó',"\\'u":'ú',"\\'y":'ý',"\\'c":'ć',"\\'n":'ń',"\\'s":'ś',"\\'z":'ź',
  "\\'A":'Á',"\\'E":'É',"\\'I":'Í',"\\'O":'Ó',"\\'U":'Ú',
  '\\"a':'ä','\\"e':'ë','\\"i':'ï','\\"o':'ö','\\"u':'ü','\\"A':'Ä','\\"O':'Ö','\\"U':'Ü',
  '\\`a':'à','\\`e':'è','\\`i':'ì','\\`o':'ò','\\`u':'ù',
  '\\^a':'â','\\^e':'ê','\\^i':'î','\\^o':'ô','\\^u':'û',
  '\\~n':'ñ','\\~a':'ã','\\~o':'õ','\\c c':'ç','\\c{c}':'ç','\\v c':'č','\\v{c}':'č','\\v s':'š','\\v{s}':'š',
  '\\v z':'ž','\\v{z}':'ž','\\o':'ø','\\O':'Ø','\\aa':'å','\\AA':'Å','\\ae':'æ','\\AE':'Æ','\\ss':'ß',
  '\\l':'ł','\\L':'Ł','\\&':'&','\\%':'%','\\_':'_','\\#':'#','\\$':'$',
};
export function delatex(s) {
  if (!s) return '';
  let out = String(s);
  // \'{e} → \'e  first, so one table covers both spellings
  out = out.replace(/\\(['"`^~])\{(\w)\}/g, '\\$1$2');
  for (const [k, v] of Object.entries(ACCENTS)) out = out.split(k).join(v);
  out = out.replace(/\\(emph|textit|textbf|textsc|mathrm|text)\s*\{([^{}]*)\}/g, '$2');
  out = out.replace(/~/g, ' ');
  out = out.replace(/[{}]/g, '');            // brace groups (case protection) — drop braces, keep text
  out = out.replace(/\\[a-zA-Z]+\s*/g, '');  // any remaining commands
  return out.replace(/\s+/g, ' ').trim();
}

/* ---------- Parser ---------- */
/** Parse BibTeX source → { entries: Map(key → entry), warnings: string[] }
    entry: { key, type, fields: {lower→cleanValue}, rawFields } */
export function parseBibtex(src) {
  const entries = new Map();
  const warnings = [];
  if (!src) return { entries, warnings };
  const s = String(src);
  let i = 0;
  const n = s.length;
  while (i < n) {
    const at = s.indexOf('@', i);
    if (at === -1) break;
    i = at + 1;
    const typeM = /^([a-zA-Z]+)\s*[{(]/.exec(s.slice(i, i + 40));
    if (!typeM) continue;
    const type = typeM[1].toLowerCase();
    i += typeM[0].length;
    if (type === 'comment' || type === 'preamble') { i = skipBalanced(s, i - 1); continue; }
    if (type === 'string') { warnings.push('@string macros are not expanded'); i = skipBalanced(s, i - 1); continue; }
    // key
    const keyM = /^\s*([^,\s{}()]+)\s*,/.exec(s.slice(i));
    if (!keyM) { warnings.push(`@${type}: missing citation key`); continue; }
    const key = keyM[1];
    i += keyM[0].length;
    // fields
    const fields = {};
    while (i < n) {
      const fm = /^\s*,?\s*([a-zA-Z][\w-]*)\s*=\s*/.exec(s.slice(i));
      if (!fm) break;
      i += fm[0].length;
      const name = fm[1].toLowerCase();
      let value = '';
      // value: {...} | "..." | bare, possibly concatenated with #
      for (;;) {
        const c = s[i];
        if (c === '{') { const end = matchBrace(s, i); value += s.slice(i + 1, end); i = end + 1; }
        else if (c === '"') { const end = matchQuote(s, i); value += s.slice(i + 1, end); i = end + 1; }
        else { const bm = /^[^,}#\s]+/.exec(s.slice(i)); if (!bm) break; value += bm[0]; i += bm[0].length; }
        const cont = /^\s*#\s*/.exec(s.slice(i));
        if (cont) i += cont[0].length; else break;
      }
      fields[name] = value.replace(/\s+/g, ' ').trim();
      const sep = /^\s*,?/.exec(s.slice(i)); i += sep[0].length;
      if (s[i] === '}' || s[i] === ')') break;
    }
    if (s[i] === '}' || s[i] === ')') i++;
    if (entries.has(key)) warnings.push(`duplicate key: ${key}`);
    entries.set(key, { key, type, fields });
  }
  return { entries, warnings };
}
function matchBrace(s, i) {           // s[i] === '{' → index of matching '}'
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '{') depth++;
    else if (s[j] === '}') { depth--; if (depth === 0) return j; }
  }
  return s.length - 1;
}
function matchQuote(s, i) {           // s[i] === '"' → closing '"' (braces protect quotes)
  let depth = 0;
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '{') depth++;
    else if (s[j] === '}') depth--;
    else if (s[j] === '"' && depth === 0) return j;
  }
  return s.length - 1;
}
function skipBalanced(s, i) {
  const open = s.indexOf('{', i);
  if (open === -1) return i + 1;
  return matchBrace(s, open) + 1;
}

/* ---------- Names ---------- */
/** "von Last, First and Last, First and others" → [{first,last}], etAl flag */
export function parseNames(authorField) {
  if (!authorField) return { names: [], etAl: false };
  const parts = delatex(authorField).split(/\s+and\s+/i);
  let etAl = false;
  const names = [];
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    if (/^others$/i.test(t)) { etAl = true; continue; }
    if (t.includes(',')) {
      const [last, first] = t.split(',', 2).map(x => x.trim());
      names.push({ first: first || '', last });
    } else {
      const ws = t.split(/\s+/);
      names.push({ first: ws.slice(0, -1).join(' '), last: ws[ws.length - 1] });
    }
  }
  return { names, etAl };
}
const initials = first => first ? first.split(/[\s.]+/).filter(Boolean).map(w => w[0].toUpperCase() + '.').join(' ') : '';

/* ---------- Inline citation labels ---------- */
/** numeric: n from useOrder; authorYear: "Smith, 2021" / "Smith & Lee, 2021" / "Smith et al., 2021" */
export function citeLabel(entry, style, num) {
  if (style !== 'author-year') return `[${num}]`;
  const { names, etAl } = parseNames(entry.fields.author || entry.fields.editor || '');
  const year = delatex(entry.fields.year || 'n.d.');
  let who;
  if (names.length === 0) who = delatex(entry.fields.title || entry.key).split(' ').slice(0, 2).join(' ');
  else if (names.length === 1 && !etAl) who = names[0].last;
  else if (names.length === 2 && !etAl) who = `${names[0].last} & ${names[1].last}`;
  else who = `${names[0].last} et al.`;
  return `(${who}, ${year})`;
}

/* ---------- Reference list formatting ---------- */
function nameListNumeric(names, etAl) {
  const parts = names.map(n => `${initials(n.first)}${n.first ? ' ' : ''}${n.last}`);
  let out;
  if (parts.length === 0) return '';
  if (parts.length === 1) out = parts[0];
  else out = parts.slice(0, -1).join(', ') + (parts.length > 2 ? ',' : '') + ' and ' + parts[parts.length - 1];
  return out + (etAl ? ' et al.' : '');
}
function nameListAY(names, etAl) {
  const parts = names.map(n => `${n.last}${n.first ? ', ' + initials(n.first) : ''}`);
  if (parts.length === 0) return '';
  let out;
  if (parts.length === 1) out = parts[0];
  else out = parts.slice(0, -1).join(', ') + ', & ' + parts[parts.length - 1];
  return out + (etAl ? ' et al.' : '');
}

/** Format one entry as an HTML reference-list item body. */
export function formatReference(entry, style) {
  const f = entry.fields;
  const { names, etAl } = parseNames(f.author || f.editor || '');
  const year = delatex(f.year || 'n.d.');
  const title = delatex(f.title || '(untitled)');
  const journal = delatex(f.journal || f.booktitle || '');
  const publisher = delatex(f.publisher || f.institution || f.school || '');
  const vol = delatex(f.volume || ''), no = delatex(f.number || ''), pages = delatex(f.pages || '').replace(/--/g, '–');
  const doi = (f.doi || '').replace(/^https?:\/\/(dx\.)?doi\.org\//, '').trim();
  const url = (f.url || '').trim();

  const bits = [];
  if (style === 'author-year') {
    bits.push(`${esc(nameListAY(names, etAl) || '—')} (${esc(year)}).`);
    bits.push(`${esc(title)}.`);
    if (journal) {
      let j = `<em>${esc(journal)}</em>`;
      if (vol) j += `, <em>${esc(vol)}</em>` + (no ? `(${esc(no)})` : '');
      if (pages) j += `, ${esc(pages)}`;
      bits.push(j + '.');
    } else if (publisher) bits.push(`${esc(publisher)}.`);
  } else {
    if (names.length) bits.push(`${esc(nameListNumeric(names, etAl))},`);
    bits.push(`“${esc(title)},”`);
    if (journal) {
      let j = `<em>${esc(journal)}</em>`;
      if (vol) j += `, vol. ${esc(vol)}`;
      if (no) j += `, no. ${esc(no)}`;
      if (pages) j += `, pp. ${esc(pages)}`;
      bits.push(j + ',');
    } else if (publisher) bits.push(`${esc(publisher)},`);
    bits.push(`${esc(year)}.`);
  }
  let html = bits.join(' ');
  if (doi) html += ` <a href="https://doi.org/${encodeURI(doi)}">doi:${esc(doi)}</a>`;
  else if (url) html += ` <a href="${esc(encodeURI(url))}">${esc(url.replace(/^https?:\/\//, ''))}</a>`;
  return html;
}

/** Alphabetical sort key for author-year reference lists. */
export function sortKey(entry) {
  const { names } = parseNames(entry.fields.author || entry.fields.editor || '');
  return ((names[0]?.last || entry.fields.title || entry.key) + ' ' + (entry.fields.year || '')).toLowerCase();
}
