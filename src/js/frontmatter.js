/* YAML-lite front matter: a leading `---` block of flat `key: value` lines.
   Deliberately tiny — no nesting, no multiline scalars. Unknown keys are kept
   (meta.extra) but unused. Not-quite-front-matter (e.g. a leading `---` hr) is
   left untouched. */

const MAX_LINES = 60;

function parseValue(v) {
  v = v.trim();
  if (v === '') return '';
  if (/^(true|yes|on)$/i.test(v)) return true;
  if (/^(false|no|off)$/i.test(v)) return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).split(',').map(s => stripQuotes(s.trim())).filter(Boolean);
  }
  return stripQuotes(v);
}
function stripQuotes(v) {
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))))
    return v.slice(1, -1);
  return v;
}

/** @returns {{meta: object, body: string, hadFrontMatter: boolean}} */
export function parseFrontMatter(src) {
  const none = { meta: {}, body: src, hadFrontMatter: false };
  if (!/^---[ \t]*\r?\n/.test(src)) return none;
  const lines = src.split('\n');
  let end = -1;
  for (let i = 1; i < Math.min(lines.length, MAX_LINES); i++) {
    if (/^(---|\.\.\.)[ \t]*\r?$/.test(lines[i])) { end = i; break; }
  }
  if (end === -1) return none;
  const meta = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (/^\s*(#|$)/.test(line)) continue;                    // comment / blank
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) return none;                                      // not front matter after all
    meta[m[1].toLowerCase()] = parseValue(m[2]);
  }
  const body = lines.slice(end + 1).join('\n');
  return { meta: normalizeMeta(meta), body, hadFrontMatter: true };
}

function normalizeMeta(meta) {
  const out = { ...meta };
  // author / authors → array
  const a = out.authors ?? out.author;
  if (a !== undefined) out.authors = Array.isArray(a) ? a : String(a).split(/,| and /).map(s => s.trim()).filter(Boolean);
  delete out.author;
  if (out.date !== undefined) out.date = String(out.date);
  // numberequations / number-equations aliases
  for (const [from, to] of [['numberequations', 'numberEquations'], ['number-equations', 'numberEquations'],
                            ['numberheadings', 'numberHeadings'], ['number-headings', 'numberHeadings'],
                            ['citationstyle', 'citationStyle'], ['citation-style', 'citationStyle']]) {
    if (from in out) { out[to] = out[from]; delete out[from]; }
  }
  return out;
}

/** Serialize a meta object back to a front-matter block (used by templates). */
export function stringifyFrontMatter(meta) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || v === null) continue;
    lines.push(`${k}: ${Array.isArray(v) ? '[' + v.join(', ') + ']' : v}`);
  }
  lines.push('---');
  return lines.join('\n');
}
