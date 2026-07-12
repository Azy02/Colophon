import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetRefs, rewriteAssetRefs, bytesEqual } from '../src/js/migrate.js';

test('assetRefs: unique ids in order of first appearance', () => {
  const md = '![a](colophon-asset:abc12345)\n![b](colophon-asset:def67890)\n<img src="colophon-asset:abc12345">';
  assert.deepEqual(assetRefs(md), ['abc12345', 'def67890']);
  assert.deepEqual(assetRefs('no refs here, not even colophon-asset without an id: colophon-asset:'), []);
  assert.deepEqual(assetRefs(null), []);
});

test('rewriteAssetRefs: mapped ids replaced, unmapped left for the caller to report', () => {
  const md = 'A ![x](colophon-asset:aaa) and ![y](colophon-asset:bbb).';
  const out = rewriteAssetRefs(md, { aaa: 'figs/figure-1.png' });
  assert.equal(out, 'A ![x](figs/figure-1.png) and ![y](colophon-asset:bbb).');
  // idempotent once fully mapped: nothing left to rewrite
  const done = rewriteAssetRefs(out, { aaa: 'figs/figure-1.png', bbb: 'figs/figure-2.png' });
  assert.equal(rewriteAssetRefs(done, { aaa: 'X', bbb: 'Y' }), done, 'no ref shapes survive a full rewrite');
});

test('rewriteAssetRefs: encoded paths (spaces as %20) pass through verbatim', () => {
  const out = rewriteAssetRefs('![p](colophon-asset:id1)', { id1: 'figs/chain%20test.png' });
  assert.equal(out, '![p](figs/chain%20test.png)');
});

test('bytesEqual: equality, inequality, length mismatch', () => {
  const enc = (s) => new TextEncoder().encode(s).buffer;
  assert.ok(bytesEqual(enc('abc'), enc('abc')));
  assert.ok(!bytesEqual(enc('abc'), enc('abd')));
  assert.ok(!bytesEqual(enc('abc'), enc('abcd')));
  assert.ok(bytesEqual(enc(''), enc('')));
});
