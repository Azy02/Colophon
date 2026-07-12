/* Seed integrity: the showcase docs and assets must stay renderable, sanitized,
   and consistent with the boot-time seeding machinery in main.js. */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { initSanitizer } from '../src/js/sanitize.js';
import { render } from '../src/js/pipeline.js';
import { WELCOME_MD, WELCOME_TEX, WELCOME_FIG_SVG, SEED_DOCS, SEED_ASSETS } from '../src/js/seeds.js';
import { looksLikeLatex, convertLatex } from '../src/js/latexin.js';

before(() => { initSanitizer(new JSDOM('').window); });

test('every seed asset id is scannable by the GC reference regex', () => {
  for (const a of SEED_ASSETS) assert.match(a.id, /^[\w-]+$/);
});

test('Welcome.md references each seed asset, so GC keeps it while the doc lives', () => {
  for (const a of SEED_ASSETS) assert.ok(WELCOME_MD.includes('colophon-asset:' + a.id), a.id);
});

test('the welcome figure SVG is inert: no scripts, handlers, or external loads', () => {
  assert.doesNotMatch(WELCOME_FIG_SVG, /<script|on[a-z]+\s*=|href=|xlink|<foreignObject|<use|<image/i);
  assert.doesNotMatch(WELCOME_FIG_SVG, /https?:\/\/(?!www\.w3\.org\/2000\/svg")/);   // only the xmlns
  assert.match(WELCOME_FIG_SVG, /^<svg /);
});

test('Welcome.md renders with the figure captioned and the asset src intact', () => {
  const { html } = render(WELCOME_MD);
  assert.match(html, /colophon-asset:welcome-fig-damped/);   // survives the sanitizer allowlist
  assert.match(html, /\{#fig:damped width=85%\}/);           // attribute text reaches postdom
});

test('Welcome.tex is genuine LaTeX and converts cleanly', () => {
  assert.ok(looksLikeLatex(WELCOME_TEX));
  const r = convertLatex(WELCOME_TEX);
  assert.equal(r.confidence, 'high');
  assert.match(r.text, /## What survives the trip/);
  assert.match(r.text, /\\label\{eq:schrodinger\}/);         // math passed through untouched
});

test('seed registry hashes are unique per doc (no version aliasing)', () => {
  for (const s of SEED_DOCS) {
    assert.equal(new Set(s.oldHashes).size, s.oldHashes.length, s.name);
  }
});
