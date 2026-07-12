import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceBlocks, blockIndexForLine, blocksOverlapping, lineOfOffset } from '../src/js/blockmap.js';

test('splits top-level blocks on blank lines', () => {
  const b = sourceBlocks('# Title\n\nFirst para.\n\nSecond para.');
  assert.equal(b.length, 3);
  assert.deepEqual(b[0], { start: 0, end: 0 });   // heading
  assert.deepEqual(b[1], { start: 2, end: 2 });   // first para
  assert.deepEqual(b[2], { start: 4, end: 4 });   // second para
});

test('a fenced code block (with internal blank lines) is ONE block', () => {
  const src = 'Intro.\n\n```python\nx = 1\n\ny = 2\n```\n\nAfter.';
  const b = sourceBlocks(src);
  assert.equal(b.length, 3);
  assert.deepEqual(b[1], { start: 2, end: 6 });   // the whole fence incl. its blank line
});

test('a multi-line paragraph stays one block', () => {
  const b = sourceBlocks('Line one\nline two\nline three\n\nNext.');
  assert.deepEqual(b[0], { start: 0, end: 2 });
  assert.deepEqual(b[1], { start: 4, end: 4 });
});

test('YAML front matter is skipped, body line numbers stay absolute', () => {
  const b = sourceBlocks('---\ntitle: X\nauthor: Y\n---\n\n# Heading\n\nBody.');
  assert.equal(b.length, 2);
  assert.deepEqual(b[0], { start: 5, end: 5 });   // # Heading is line 5 (0-based)
  assert.deepEqual(b[1], { start: 7, end: 7 });
});

test('a loose list (blank lines between items) merges into one block', () => {
  const b = sourceBlocks('- a\n\n- b\n\n- c\n\nAfter.');
  assert.equal(b.length, 2);
  assert.deepEqual(b[0], { start: 0, end: 4 });   // the whole list
  assert.deepEqual(b[1], { start: 6, end: 6 });
});

test('a table block is a single block', () => {
  const b = sourceBlocks('| A | B |\n|---|---|\n| 1 | 2 |\n\nText.');
  assert.deepEqual(b[0], { start: 0, end: 2 });
});

test('blockIndexForLine / blocksOverlapping', () => {
  const b = sourceBlocks('# H\n\nPara one\nstill one\n\nPara two');
  assert.equal(blockIndexForLine(b, 0), 0);
  assert.equal(blockIndexForLine(b, 3), 1);        // inside "Para one / still one"
  assert.equal(blockIndexForLine(b, 5), 2);
  assert.equal(blockIndexForLine(b, 1), -1);       // blank line, no block
  assert.deepEqual(blocksOverlapping(b, 2, 5), [1, 2]);  // selection spanning two blocks
});

test('lineOfOffset counts newlines up to an offset', () => {
  const src = 'a\nbb\nccc';
  assert.equal(lineOfOffset(src, 0), 0);
  assert.equal(lineOfOffset(src, 2), 1);     // start of "bb"
  assert.equal(lineOfOffset(src, 5), 2);     // start of "ccc"
});

test('footnote definitions are skipped (they render into the generated footnotes section)', () => {
  const b = sourceBlocks('Para one\n\n[^ft]: The footnote text.\n\nPara two');
  assert.equal(b.length, 2);
  assert.deepEqual(b[0], { start: 0, end: 0 });
  assert.deepEqual(b[1], { start: 4, end: 4 });    // NOT shifted by the definition
});

test('a mid-document footnote definition does not shift later pairs', () => {
  const b = sourceBlocks('# H\n\n[^a]: def line\n\nAfter\n\n[^b]: another\n\nLast');
  assert.equal(b.length, 3);                        // H, After, Last
  assert.equal(b[1].start, 4);
  assert.equal(b[2].start, 8);
});

test('a [TOC] marker stays a source block (it pairs with the rendered nav.toc)', () => {
  const b = sourceBlocks('# H\n\n[TOC]\n\nBody');
  assert.equal(b.length, 3);
  assert.deepEqual(b[1], { start: 2, end: 2 });
});

/* Display math must be its own block, even when equations are squeezed together
   (no blank lines) — otherwise the selection-mirror block-zip misaligns and
   selecting one equation highlights the wrong source or none (user-reported,
   the eqs 30-34 case from Maresca-Curtin). */
test('squeezed display equations each get their own source block', () => {
  const src = 'intro\n$$a = b \\tag{30}$$\n$$c = d \\tag{31}$$\n$$e = f \\tag{32}$$\nafter';
  const b = sourceBlocks(src);
  // intro[0], eq30[1], eq31[2], eq32[3], after[4]
  assert.equal(b.length, 5);
  assert.deepEqual(b[0], { start: 0, end: 0 });   // intro
  assert.deepEqual(b[1], { start: 1, end: 1 });   // eq30
  assert.deepEqual(b[2], { start: 2, end: 2 });   // eq31
  assert.deepEqual(b[3], { start: 3, end: 3 });   // eq32  ← the one that used to be mistagged
  assert.deepEqual(b[4], { start: 4, end: 4 });   // after
});

test('multi-line $$…$$ display block spans opener to closer as one block', () => {
  const src = 'text\n$$\na = b\n$$\n$$\nc = d\n$$\nmore';
  const b = sourceBlocks(src);
  assert.deepEqual(b[0], { start: 0, end: 0 });   // text
  assert.deepEqual(b[1], { start: 1, end: 3 });   // first multi-line eq
  assert.deepEqual(b[2], { start: 4, end: 6 });   // second multi-line eq
  assert.deepEqual(b[3], { start: 7, end: 7 });   // more
});

test('bare \\[ … \\] display delimiters segment as their own block too', () => {
  const src = 'lead\n\\[ x^2 \\]\ntail';
  const b = sourceBlocks(src);
  assert.deepEqual(b, [{ start: 0, end: 0 }, { start: 1, end: 1 }, { start: 2, end: 2 }]);
});

test('blank-separated equations still map 1:1 (no regression)', () => {
  const src = 'p\n\n$$a$$\n\n$$b$$\n\nq';
  const b = sourceBlocks(src);
  assert.equal(b.length, 4);
  assert.deepEqual(b[1], { start: 2, end: 2 });
  assert.deepEqual(b[2], { start: 4, end: 4 });
});

test('inline $…$ math does not trigger a display split', () => {
  const src = 'a paragraph with $x^2$ inline math\nand a second line';
  const b = sourceBlocks(src);
  assert.equal(b.length, 1);
  assert.deepEqual(b[0], { start: 0, end: 1 });
});
