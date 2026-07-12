import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScrollMap, mapScroll } from '../src/js/syncmap.js';

test('endpoints are exact: 0→0 and fromTotal→toTotal', () => {
  const m = buildScrollMap([{ from: 500, to: 900 }], 1000, 2000);
  assert.equal(mapScroll(m, 0), 0);
  assert.equal(mapScroll(m, 1000), 2000);
});

test('anchors are hit exactly and interpolated between', () => {
  const m = buildScrollMap([{ from: 400, to: 1000 }], 1000, 2000);
  assert.equal(mapScroll(m, 400), 1000);
  assert.equal(mapScroll(m, 200), 500);     // linear on [0,400]→[0,1000]
  assert.equal(mapScroll(m, 700), 1500);    // linear on [400,1000]→[1000,2000]
});

test('non-proportional content: image block compresses one side', () => {
  // a short source region (lines at 100..120px) renders as a tall image
  // (preview 100..800px) — proportional sync would drift ~everywhere
  const m = buildScrollMap([{ from: 100, to: 100 }, { from: 120, to: 800 }], 1000, 2000);
  assert.equal(mapScroll(m, 100), 100);
  assert.equal(mapScroll(m, 110), 450);     // midway through the image's source lines
  assert.equal(mapScroll(m, 120), 800);
});

test('unsorted input is sorted; duplicate X keeps the first', () => {
  const m = buildScrollMap([{ from: 600, to: 1200 }, { from: 200, to: 300 }, { from: 200.4, to: 999 }], 1000, 2000);
  const xs = m.map((p) => p.from);
  assert.deepEqual(xs, [0, 200, 600, 1000]);
  assert.equal(mapScroll(m, 200), 300);
});

test('a backwards anchor (order-zip drift) cannot make the map jump back', () => {
  const m = buildScrollMap([{ from: 300, to: 900 }, { from: 500, to: 400 }], 1000, 2000);
  // to is forced monotonic: the bad pair flattens instead of reversing
  let prev = -1;
  for (let y = 0; y <= 1000; y += 50) {
    const v = mapScroll(m, y);
    assert.ok(v >= prev, `monotonic at y=${y}`);
    prev = v;
  }
});

test('anchors outside the range are clamped, near-end anchors yield to the endpoint', () => {
  const m = buildScrollMap([{ from: -50, to: -10 }, { from: 999.9, to: 500 }, { from: 2000, to: 99999 }], 1000, 2000);
  assert.equal(mapScroll(m, 0), 0);
  assert.equal(mapScroll(m, 1000), 2000);   // the 999.9 anchor may not drag the endpoint down
});

test('empty/garbage input degrades to a straight proportional line', () => {
  for (const pairs of [[], null, undefined, [{ from: NaN, to: 5 }, { from: 5 }]]) {
    const m = buildScrollMap(pairs, 1000, 500);
    assert.equal(mapScroll(m, 0), 0);
    assert.equal(mapScroll(m, 500), 250);
    assert.equal(mapScroll(m, 1000), 500);
  }
});

test('queries outside the domain clamp to the endpoints', () => {
  const m = buildScrollMap([{ from: 500, to: 700 }], 1000, 2000);
  assert.equal(mapScroll(m, -100), 0);
  assert.equal(mapScroll(m, 5000), 2000);
});

test('reversed-axis build (preview→editor direction) stays monotonic through flat spans', () => {
  // e→p pairs where two blocks share a preview Y (collapsed margin) — swapping
  // axes for the p→e map must dedupe the flat X and stay monotonic
  const pairs = [{ from: 100, to: 400 }, { from: 300, to: 400 }, { from: 600, to: 900 }];
  const inv = buildScrollMap(pairs.map((p) => ({ from: p.to, to: p.from })), 2000, 1000);
  let prev = -1;
  for (let y = 0; y <= 2000; y += 100) {
    const v = mapScroll(inv, y);
    assert.ok(v >= prev, `monotonic at y=${y}`);
    prev = v;
  }
  assert.equal(mapScroll(inv, 2000), 1000);
});

test('mapScroll on a malformed map is the identity (never throws)', () => {
  assert.equal(mapScroll(null, 42), 42);
  assert.equal(mapScroll([], 42), 42);
  assert.equal(mapScroll([{ from: 0, to: 0 }], 42), 42);
});
