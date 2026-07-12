/* Zero-config build: esbuild-bundle the app, inline every vendor + CSS blob into
   the template, and write dist/Colophon.html. Deterministic, no network, no deps
   beyond esbuild. Placeholder substitution is literal (split/join) because the
   inlined values contain regex-special sequences like $&. */

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const P = (...a) => join(root, ...a);
const read = (f) => readFileSync(P(f), 'utf8');
const kb = (n) => (n / 1024).toFixed(1) + ' KB';

// A blob may only break out of its HOST tag: a </script prematurely ends a
// <script> element, a </style ends a <style> element. (A </style> inside a
// <script> — e.g. app code that assembles an HTML export — is inert, per the
// HTML tokenizer.) Escaping is not generally safe, so fail loudly for a human.
function assertNoCloser(name, text, closer) {
  if (text.includes(closer)) {
    throw new Error(`Refusing to inline ${name}: it contains ${closer} which would break out of its host tag. A human must review — do not blindly escape.`);
  }
}

const result = await build({
  entryPoints: [P('src/js/main.js')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: false,          // a readable shipped file is a trust/debuggability feature
  write: false,
  legalComments: 'none',
  logLevel: 'warning',
});
const APP_JS = result.outputFiles[0].text;

// host: 'style' → inlined into <style>…</style>; 'script' → into <script>…</script>
const styleParts = {
  '{{KATEX_CSS}}': read('vendor/katex-0.16.9.css'),
  '{{CHROME_CSS}}': read('src/css/chrome.css'),
  '{{READING_CSS}}': read('src/css/reading.css'),
  '{{PRINT_CSS}}': read('src/css/print.css'),
};
// KaTeX JS is NOT inlined separately — pipeline.js imports it, so esbuild bundles
// it (plus the mhchem extension) into APP_JS. Only its font CSS is vendored.
const scriptParts = {
  '{{MERMAID_JS}}': read('vendor/mermaid-11.16.0.min.js'),
  '{{APP_JS}}': APP_JS,
};
for (const [name, text] of Object.entries(styleParts)) assertNoCloser(name, text, '</style');
for (const [name, text] of Object.entries(scriptParts)) assertNoCloser(name, text, '</script');
const parts = { ...styleParts, ...scriptParts };

let html = read('src/template.html');
for (const [token, value] of Object.entries(parts)) html = html.split(token).join(value);
// Check the exact tokens are gone — not any '{{', which occurs naturally in minified JS.
for (const token of Object.keys(parts)) {
  if (html.includes(token)) throw new Error(`Unreplaced placeholder ${token} remains in the template.`);
}

mkdirSync(P('dist'), { recursive: true });
writeFileSync(P('dist/Colophon.html'), html);

// Artifact variant: a BODY FRAGMENT (no doctype/html/head/body) for claude.ai
// Artifact hosting — the 4 CSS blobs as <style> elements, then the app markup, then
// the two script blocks (mermaid text/plain + app), in that order. main.js boots on
// a microtask when the DOM is already parsed, and store.js falls back to memory when
// IndexedDB is unavailable, so the app runs when injected into a foreign body.
const bodyInner = html.slice(html.indexOf('<body>') + '<body>'.length, html.lastIndexOf('</body>')).trim();
const artifact = [
  '<style>' + styleParts['{{KATEX_CSS}}'] + '</style>',
  '<style>' + styleParts['{{CHROME_CSS}}'] + '</style>',
  '<style>' + styleParts['{{READING_CSS}}'] + '</style>',
  '<style>' + styleParts['{{PRINT_CSS}}'] + '</style>',
  bodyInner,
  '',
].join('\n');
writeFileSync(P('dist/Colophon-artifact.html'), artifact);

console.log('Colophon build → dist/Colophon.html + dist/Colophon-artifact.html');
for (const [name, text] of Object.entries(parts)) console.log('  ' + name.padEnd(15) + kb(Buffer.byteLength(text)));
console.log('  ' + '(app bundle unminified)');
console.log('  Colophon.html          ' + kb(Buffer.byteLength(html)));
console.log('  Colophon-artifact.html ' + kb(Buffer.byteLength(artifact)));
