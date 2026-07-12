/* autolist.js — Enter continues the list you're typing (pure, testable).

   Pressing Enter inside a list item / task item / blockquote inserts the next
   marker automatically; pressing Enter on an EMPTY item removes its marker
   instead (the universal "I'm done with this list" gesture). Everything else
   returns null so the key falls through to the default newline.

   The core works on one line (the CodeMirror path reads the line without
   serializing the whole document); listContinuation() is the convenience
   wrapper for the textarea. Returned edits are {from, to, insert, caret}
   character offsets, applied undo-preserving by the caller. */

const ITEM = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?/;
const QUOTE = /^(\s*(?:>\s?)+)/;
/* a thematic break (`---`, `* * *`, `___`) opens with a `-`/`*` + space so it
   matches ITEM, but it is an <hr>, not a list — never continue it */
const THEMATIC = /^\s{0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/;

/** Continuation edit for Enter at `caret` on the line [lineStart, lineEnd).
 *  `line` is the line's text (no newline). Returns null when Enter should
 *  behave normally. */
export function continuationForLine(line, lineStart, lineEnd, caret) {
  if (THEMATIC.test(line)) return null;   // `- - -` is a horizontal rule, not a bullet
  const item = line.match(ITEM);
  if (item) {
    const head = item[0].length;
    if (caret < lineStart + head) return null;           // caret inside the marker — don't touch
    if (!line.slice(head).trim()) {                       // empty item → exit the list
      return { from: lineStart, to: lineEnd, insert: '', caret: lineStart };
    }
    const num = item[2].match(/^(\d+)([.)])$/);
    const marker = num ? (+num[1] + 1) + num[2] : item[2];
    const insert = '\n' + item[1] + marker + item[3] + (item[4] ? '[ ] ' : '');
    return { from: caret, to: caret, insert, caret: caret + insert.length };
  }
  const quote = line.match(QUOTE);
  if (quote) {
    const head = quote[1].length;
    if (caret < lineStart + head) return null;
    if (!line.slice(head).trim()) {                       // empty quote line → exit
      return { from: lineStart, to: lineEnd, insert: '', caret: lineStart };
    }
    const insert = '\n' + quote[1];
    return { from: caret, to: caret, insert, caret: caret + insert.length };
  }
  return null;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
/* Is the offset inside a fenced code block? Count fence toggles from the top —
   the textarea has no syntax tree, so a scan is the only signal, and continuing
   a `- ` line inside a shell/YAML snippet would corrupt the code. */
function insideFence(src, offset) {
  let open = null, pos = 0;
  const lines = src.split('\n');
  for (const ln of lines) {
    const lineStart = pos;
    pos += ln.length + 1;                     // +1 for the '\n'
    if (lineStart >= offset) break;           // reached the caret's line — stop
    const m = ln.match(FENCE);
    if (!open) { if (m) open = m[1][0]; }      // opening fence char (` or ~)
    else if (m && m[1][0] === open) open = null;   // matching closer
  }
  return !!open;
}

/** Textarea convenience: full text + collapsed caret offset. */
export function listContinuation(text, caret) {
  const src = String(text == null ? '' : text);
  const at = Math.max(0, Math.min(src.length, caret | 0));
  if (insideFence(src, at)) return null;      // never continue a list inside code
  const lineStart = src.lastIndexOf('\n', at - 1) + 1;
  const nl = src.indexOf('\n', at);
  const lineEnd = nl === -1 ? src.length : nl;
  return continuationForLine(src.slice(lineStart, lineEnd), lineStart, lineEnd, at);
}

export default listContinuation;
