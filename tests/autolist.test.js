import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listContinuation } from '../src/js/autolist.js';

/* apply an edit the way the app does, for end-state assertions */
function applied(text, caret) {
  const r = listContinuation(text, caret);
  if (!r) return null;
  return { text: text.slice(0, r.from) + r.insert + text.slice(r.to), caret: r.caret };
}

test('bullet continues with the same marker and indent', () => {
  const t = '- alpha';
  const a = applied(t, t.length);
  assert.equal(a.text, '- alpha\n- ');
  assert.equal(a.caret, a.text.length);
  assert.equal(applied('  * x', 5).text, '  * x\n  * ');
});

test('numbered list increments (both . and ) styles)', () => {
  assert.equal(applied('1. one', 6).text, '1. one\n2. ');
  assert.equal(applied('12) twelve', 10).text, '12) twelve\n13) ');
});

test('task item continues as a fresh unchecked box', () => {
  assert.equal(applied('- [x] done', 10).text, '- [x] done\n- [ ] ');
  assert.equal(applied('- [ ] todo', 10).text, '- [ ] todo\n- [ ] ');
});

test('blockquote continues, nested markers preserved', () => {
  assert.equal(applied('> quoted', 8).text, '> quoted\n> ');
  assert.equal(applied('> > deep', 8).text, '> > deep\n> > ');
});

test('Enter on an EMPTY item exits the list (marker removed, no new line)', () => {
  const a = applied('- alpha\n- ', 10);
  assert.equal(a.text, '- alpha\n');
  assert.equal(a.caret, 8);
  assert.equal(applied('1. x\n2. ', 8).text, '1. x\n');
  assert.equal(applied('> ', 2).text, '');
});

test('mid-line Enter splits the item: remainder lands after the new marker', () => {
  const t = '- alpha beta';
  const a = applied(t, 7);                       // caret between "alpha" and " beta"
  assert.equal(a.text, '- alpha\n-  beta');
  assert.equal(a.caret, 10);                     // right after the inserted "- "
});

test('caret inside the marker itself falls through (null)', () => {
  assert.equal(listContinuation('- alpha', 1), null);
  assert.equal(listContinuation('12. x', 2), null);
});

test('plain prose, headings, code-ish lines fall through (null)', () => {
  assert.equal(listContinuation('just a line', 6), null);
  assert.equal(listContinuation('# heading', 9), null);
  assert.equal(listContinuation('  indented prose', 10), null);
  assert.equal(listContinuation('', 0), null);
});

test('multi-line document: only the caret line matters', () => {
  const t = '# H\n\n- one\n- two\nprose';
  const a = applied(t, 10);                      // end of "- one"
  assert.equal(a.text, '# H\n\n- one\n- \n- two\nprose');
});

test('a lone "-" with no space is not a list item', () => {
  assert.equal(listContinuation('-', 1), null);
  assert.equal(listContinuation('--- ', 4), null);   // hr, not a list
});

/* Debug-sweep regressions (2026-07-10 finder) */
test('thematic breaks are not continued as bullets', () => {
  assert.equal(listContinuation('- - -', 5), null);
  assert.equal(listContinuation('* * *', 5), null);
  assert.equal(listContinuation('---', 3), null);
  assert.equal(listContinuation('___', 3), null);
  assert.equal(listContinuation('* * * *', 7), null);
});

test('Enter inside a fenced code block does NOT inject a list marker', () => {
  const doc = '```yaml\ntags:\n- alpha\n```\n';
  const caret = doc.indexOf('- alpha') + '- alpha'.length;   // end of the "- alpha" line, inside the fence
  assert.equal(listContinuation(doc, caret), null);
  // a real list line OUTSIDE the fence still continues
  const doc2 = '```\ncode\n```\n\n- item';
  assert.ok(listContinuation(doc2, doc2.length));
});

test('a list line before an unclosed fence still continues (fence opens after the caret)', () => {
  const doc = '- item\n\n```\ncode';
  assert.ok(listContinuation(doc, 6));   // caret at end of "- item", before the fence
});

test('tilde fences count too, and a mismatched fence char does not close', () => {
  const doc = '~~~\n- a\n```\n- b';   // ``` does not close a ~~~ block
  const caret = doc.indexOf('- b') + 3;
  assert.equal(listContinuation(doc, caret), null);   // still inside the ~~~ block
});
