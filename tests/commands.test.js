import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCommands, parseKeySpec, fuzzyMatch, prettyKeys, matchesEvent } from '../src/js/commands.js';

// A stub ctx is enough: createCommands only stores run/when closures, never calls them.
const ctx = { editor: {} };

test('registry has unique ids and the required shape', () => {
  const cmds = createCommands(ctx);
  assert.ok(Array.isArray(cmds) && cmds.length > 0);
  const ids = new Set();
  for (const c of cmds) {
    assert.equal(typeof c.id, 'string', 'id is a string');
    assert.ok(!ids.has(c.id), 'duplicate id: ' + c.id);
    ids.add(c.id);
    assert.equal(typeof c.title, 'string');
    assert.equal(typeof c.cat, 'string');
    assert.ok(Array.isArray(c.keys), 'keys is an array');
    assert.equal(typeof c.run, 'function');
  }
});

test('the promised core shortcuts are present', () => {
  const cmds = createCommands(ctx);
  const byKey = new Map();
  for (const c of cmds) for (const k of c.keys) byKey.set(k, c.id);
  for (const k of ['Mod+S', 'Mod+K', 'Mod+P', 'Mod+F', 'Mod+Alt+N', 'Mod+B', 'Mod+I', 'Mod+E',
    'Mod+Shift+K', 'Mod+Alt+1', 'Mod+Alt+2', 'Mod+Alt+3', 'Mod+\\', 'F2', '?']) {
    assert.ok(byKey.has(k), 'missing shortcut ' + k);
  }
});

test('every keys entry parses', () => {
  for (const c of createCommands(ctx)) {
    for (const k of c.keys) {
      const ks = parseKeySpec(k);
      assert.ok(ks, 'unparseable key "' + k + '" on command ' + c.id);
      assert.ok(ks.key.length >= 1);
    }
  }
});

test('parseKeySpec details', () => {
  assert.deepEqual(parseKeySpec('Mod+Shift+K'), { mod: true, ctrl: false, meta: false, alt: false, shift: true, key: 'k' });
  assert.equal(parseKeySpec('F2').key, 'f2');
  assert.equal(parseKeySpec('?').key, '?');
  assert.equal(parseKeySpec('Mod+\\').key, '\\');
  assert.equal(parseKeySpec(''), null);
  assert.equal(parseKeySpec('Bogus+X'), null);
});

test('fuzzy subsequence matcher', () => {
  assert.ok(fuzzyMatch('sv', 'Save document') >= 0);        // subsequence
  assert.ok(fuzzyMatch('save', 'Save document') > fuzzyMatch('sv', 'Save document'));
  assert.equal(fuzzyMatch('xyz', 'Save'), -1);               // not a subsequence
  assert.ok(fuzzyMatch('', 'anything') >= 0);                // empty query matches
  assert.ok(fuzzyMatch('open', 'Open: notes.md') >= 0);
  assert.ok(fuzzyMatch('vpre', 'View: Preview') >= 0);
});

test('prettyKeys renders a human label', () => {
  const s = prettyKeys('Mod+Shift+K');
  assert.ok(/K$/.test(s));
  assert.ok(/Shift|⇧/.test(s));
  assert.equal(prettyKeys('F2'), 'F2');
});

/* Alt-combo reachability (2026-07-10): on macOS ⌥+letter delivers a composed
   glyph in e.key, so matchesEvent must fall back to the physical e.code. */
test('matchesEvent: Alt binding matches via physical e.code when e.key is a composed glyph', () => {
  const ks = parseKeySpec('Mod+Alt+V');
  // macOS: ⌘⌥V arrives as key:'√' (composed) but code:'KeyV'
  const composed = { ctrlKey: false, metaKey: true, altKey: true, shiftKey: false, key: '\u221a', code: 'KeyV' };
  assert.ok(matchesEvent(composed, { ...ks, mod: false, meta: true }), 'matches on e.code');
  // plain e.key path still works when the layout delivers the letter
  const plain = { ctrlKey: false, metaKey: true, altKey: true, shiftKey: false, key: 'v', code: 'KeyV' };
  assert.ok(matchesEvent(plain, { ...ks, mod: false, meta: true }));
  // the code fallback is Alt-only: a non-Alt binding never matches a wrong e.key
  const noAlt = parseKeySpec('Mod+B');
  assert.ok(!matchesEvent({ ctrlKey: false, metaKey: true, altKey: false, shiftKey: false, key: 'x', code: 'KeyB' }, { ...noAlt, mod: false, meta: true }));
});
