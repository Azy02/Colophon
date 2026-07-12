/* Colophon — library→project migration helpers (pure, testable).

   The M3 flow (docs/ON_DISK_PROJECTS.md §5) copies every in-app document into
   the linked project folder, extracting embedded colophon-asset: images into
   figs/ and rewriting references to relative paths. These are the pure text
   halves; the IO half (write → read-back verify → report) lives in main.js
   next to the rest of the folder machinery. */

const REF_RE = /colophon-asset:([\w-]+)/g;

/** Unique asset ids referenced by a document's text, in order of first use. */
export function assetRefs(text) {
  const seen = new Set();
  for (const m of String(text ?? '').matchAll(REF_RE)) seen.add(m[1]);
  return [...seen];
}

/** Replace every colophon-asset:<id> with map[id] (an already-encoded relative
    path). Ids missing from the map are left untouched — the caller reports
    them rather than silently dropping a reference. */
export function rewriteAssetRefs(text, map) {
  return String(text ?? '').replace(REF_RE, (m, id) => (map && map[id] != null) ? map[id] : m);
}

/** Byte-equality for read-back verification of binary writes. */
export function bytesEqual(x, y) {
  if (x.byteLength !== y.byteLength) return false;
  const a = new Uint8Array(x), b = new Uint8Array(y);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
