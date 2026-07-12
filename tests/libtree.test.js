import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLibTree, isSafeRelPath, DOC_RE, ASSET_RE } from '../src/js/libtree.js';

test('isSafeRelPath accepts plain and nested relative paths', () => {
  for (const ok of ['a.md', 'figs/x.svg', 'a/b/c.pdf', 'notes 2.md', 'figs/2024 plots/x.png']) {
    assert.equal(isSafeRelPath(ok), true, ok);
  }
});

test('isSafeRelPath rejects traversal, absolute, schemes, degenerate segments', () => {
  for (const bad of ['', '/a.md', '../x.md', 'a/../b.md', 'a//b.md', './a.md', 'a/.', 'http://x/y.png', 'data:image/png;base64,x', null, undefined, 42]) {
    assert.equal(isSafeRelPath(bad), false, String(bad));
  }
});

test('buildLibTree splits root docs, root assets, and per-dir groups', () => {
  const t = buildLibTree([
    { name: 'main.md', kind: 'doc' },
    { name: 'zeta.md', kind: 'doc' },
    { name: 'cover.png', kind: 'asset' },
    { name: 'figs/b.svg', kind: 'asset' },
    { name: 'figs/a.svg', kind: 'asset' },
    { name: 'refs/paper.pdf', kind: 'asset' },
    { name: 'notes/draft.md', kind: 'doc' },
  ]);
  assert.deepEqual(t.rootDocs.map((d) => d.name), ['main.md', 'zeta.md']);
  assert.deepEqual(t.rootAssets.map((a) => a.name), ['cover.png']);
  assert.deepEqual(t.groups.map((g) => g.dir), ['figs', 'notes', 'refs']);
  const figs = t.groups[0];
  assert.deepEqual(figs.assets.map((a) => a.name), ['figs/a.svg', 'figs/b.svg']);   // sorted, full paths kept
  assert.equal(figs.count, 2);
  assert.equal(t.groups[1].docs[0].name, 'notes/draft.md');
});

test('buildLibTree groups deeper nesting under the top-level dir', () => {
  const t = buildLibTree([{ name: 'figs/2024/deep.png', kind: 'asset' }]);
  assert.equal(t.groups.length, 1);
  assert.equal(t.groups[0].dir, 'figs');
  assert.equal(t.groups[0].assets[0].name, 'figs/2024/deep.png');
});

test('buildLibTree drops unsafe paths and tolerates empty/absent input', () => {
  const t = buildLibTree([
    { name: '../escape.md', kind: 'doc' },
    { name: '/abs.md', kind: 'doc' },
    { name: 'ok.md', kind: 'doc' },
    null,
  ]);
  assert.deepEqual(t.rootDocs.map((d) => d.name), ['ok.md']);
  assert.deepEqual(buildLibTree([]).groups, []);
  assert.deepEqual(buildLibTree(undefined).rootDocs, []);
});

test('DOC_RE and ASSET_RE split the world as intended', () => {
  for (const d of ['a.md', 'a.markdown', 'a.txt', 'a.bib', 'a.tex']) assert.ok(DOC_RE.test(d), d);
  for (const a of ['a.png', 'a.jpg', 'a.jpeg', 'a.svg', 'a.webp', 'a.pdf', 'a.avif']) assert.ok(ASSET_RE.test(a), a);
  assert.ok(!DOC_RE.test('a.png') && !ASSET_RE.test('a.md'));
  assert.ok(!DOC_RE.test('a.docx') && !ASSET_RE.test('a.docx'));   // neither — invisible to the tree
});
