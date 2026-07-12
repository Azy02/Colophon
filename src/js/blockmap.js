/* blockmap.js — approximate source-block ↔ rendered-block correspondence for
   selection mirroring (pure, testable).

   SPIKE / block-level only. The render pipeline replaces multi-line code and
   math with single-line sentinels before marked parses, so marked's own token
   positions don't line up with the editor's source lines — real parser source
   maps aren't available without reworking the pipeline. Instead we segment the
   ORIGINAL source into top-level blocks ourselves and zip them, in order, with
   the preview's top-level content blocks. Good for prose/headings/code/tables;
   loose lists and generated sections (title block, references) are where the
   order-zip can drift — documented, and the reason this is a spike. */

const FENCE = /^(\s*)(`{3,}|~{3,})/;
const LIST = /^\s*([-*+]|\d+[.)])\s/;
const BLANK = /^\s*$/;
const FOOTNOTE_DEF = /^\[\^[^\]]+\]:/;
/* A line that OPENS a display-math block: `$$…` or `\[…`. The pipeline turns
   every `$$…$$` / `\[…\]` into its own block-level element regardless of blank
   lines, so each must be its own source block — otherwise squeezed equations
   (no blank line between them) merge here and the block-zip that drives
   selection mirroring misaligns (a later eq highlights the wrong source, or
   none). Inline `$…$` is untouched (single `$`, and never line-leading here). */
const DISPLAY_OPEN = /^\s*(\$\$|\\\[)/;

/* → [{ start, end }] inclusive 0-based line ranges of top-level source blocks,
   with absolute line numbers (so a caret offset maps straight in). Leading YAML
   front matter is skipped (it renders as a generated title block, not a body
   block). */
export function sourceBlocks(src) {
  const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  if (lines[0] != null && /^---\s*$/.test(lines[0])) {          // YAML front matter
    let j = 1;
    while (j < lines.length && !/^---\s*$/.test(lines[j])) j++;
    if (j < lines.length) i = j + 1;
  }
  const blocks = [];
  while (i < lines.length) {
    if (BLANK.test(lines[i])) { i++; continue; }
    if (FOOTNOTE_DEF.test(lines[i])) {   // renders into the generated footnotes section, not the flow —
      while (i < lines.length && !BLANK.test(lines[i])) i++;   // including it would shift every later pair
      continue;
    }
    const start = i;
    const fence = lines[i].match(FENCE);
    if (fence) {
      const close = new RegExp('^\\s*' + fence[2][0] + '{' + fence[2].length + ',}\\s*$');
      i++;
      while (i < lines.length && !close.test(lines[i])) i++;
      if (i < lines.length) i++;                                // consume closing fence
      blocks.push({ start, end: i - 1 });
      continue;
    }
    const disp = lines[i].match(DISPLAY_OPEN);
    if (disp) {                                                 // display math is its own block
      const isDollar = disp[1] === '$$';
      const closeTok = isDollar ? '$$' : '\\]';
      const rest = lines[i].slice(lines[i].indexOf(disp[1]) + disp[1].length);
      if (rest.includes(closeTok)) { blocks.push({ start, end: i }); i++; continue; }   // one-line $$…$$
      i++;                                                      // multi-line: scan to the closer
      while (i < lines.length && !lines[i].includes(closeTok)) i++;
      if (i < lines.length) i++;                                // consume the closing line
      blocks.push({ start, end: i - 1 });
      continue;
    }
    // a normal block stops at a blank line, a fence, OR a display-math opener
    // (so `intro\n$$a$$` splits into two blocks, matching the preview). The
    // start line already passed the DISPLAY_OPEN check above, so advance first.
    i++;
    while (i < lines.length && !BLANK.test(lines[i]) && !FENCE.test(lines[i]) && !DISPLAY_OPEN.test(lines[i])) i++;
    blocks.push({ start, end: i - 1 });
  }
  // merge blank-line-separated list blocks into one (a loose list is one <ul>/<ol>)
  const merged = [];
  for (const b of blocks) {
    const prev = merged[merged.length - 1];
    if (prev && LIST.test(lines[b.start]) && LIST.test(lines[prev.start])) prev.end = b.end;
    else merged.push({ ...b });
  }
  return merged;
}

/** Index of the block containing a given line, or -1. */
export function blockIndexForLine(blocks, line) {
  return blocks.findIndex((b) => line >= b.start && line <= b.end);
}

/** Indices of every block overlapping the inclusive line range [l0, l1]. */
export function blocksOverlapping(blocks, l0, l1) {
  const out = [];
  for (let k = 0; k < blocks.length; k++) if (blocks[k].start <= l1 && blocks[k].end >= l0) out.push(k);
  return out;
}

/** Line number (0-based) of a character offset in the source. */
export function lineOfOffset(src, offset) {
  let line = 0;
  const n = Math.min(offset, src.length);
  for (let k = 0; k < n; k++) if (src.charCodeAt(k) === 10) line++;
  return line;
}

export default sourceBlocks;
