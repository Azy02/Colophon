/* syncmap.js — piecewise-linear scroll correspondence between two panes,
   built from block anchor pairs (pure, testable).

   Purely proportional scroll sync (position ratio) drifts badly the moment the
   two panes' content stops being proportional — one source line can render as
   a 400px image, a display equation, or a mermaid diagram, which is exactly
   the shape of document Colophon exists for. Instead, main.js measures a
   pixel-Y anchor pair per rendered block (source-line top in the editor ↔
   block top in the preview, both in scroll/content space) and this module
   turns those into a monotonic piecewise-linear map with exact endpoints, so
   top meets top, bottom meets bottom, and every anchored block lines up in
   between.

   The block pairing upstream is an order-zip (see blockmap.js) and can drift
   on exotic documents, so buildScrollMap DEFENDS itself: anchors are sorted,
   clamped into range, deduplicated on X, and forced monotonic on Y — a bad
   pair degrades alignment locally instead of making the map jump backwards. */

/** Build a monotonic piecewise map from anchor pairs.
 *  pairs:     [{from, to}] pixel Ys in source/target content space (any order)
 *  fromTotal: source pane scrollHeight (map domain end)
 *  toTotal:   target pane scrollHeight (map range end)
 *  → [{from, to}] strictly increasing in `from`, non-decreasing in `to`,
 *    always starting at {0,0} and ending at {fromTotal,toTotal}. */
export function buildScrollMap(pairs, fromTotal, toTotal) {
  const F = Math.max(1, +fromTotal || 0), T = Math.max(0, +toTotal || 0);
  const pts = [{ from: 0, to: 0 }];
  const clean = (Array.isArray(pairs) ? pairs : [])
    .filter((p) => p && Number.isFinite(p.from) && Number.isFinite(p.to))
    .map((p) => ({ from: Math.min(F, Math.max(0, p.from)), to: Math.min(T, Math.max(0, p.to)) }))
    .sort((a, b) => a.from - b.from);
  for (const p of clean) {
    const prev = pts[pts.length - 1];
    if (p.from - prev.from < 1) continue;          // duplicate/degenerate X — first wins
    if (F - p.from < 1) continue;                  // too close to the end — the endpoint owns it
    pts.push({ from: p.from, to: Math.max(p.to, prev.to) });   // never map backwards
  }
  pts.push({ from: F, to: Math.max(T, pts[pts.length - 1].to) });
  return pts;
}

/** Piecewise-linear lookup: source content Y → target content Y. */
export function mapScroll(map, y) {
  if (!Array.isArray(map) || map.length < 2) return y;
  if (!(y > map[0].from)) return map[0].to;
  let lo = 0, hi = map.length - 1;
  if (y >= map[hi].from) return map[hi].to;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (map[mid].from <= y) lo = mid; else hi = mid;
  }
  const a = map[lo], b = map[hi];
  const t = (y - a.from) / ((b.from - a.from) || 1);
  return a.to + t * (b.to - a.to);
}

export default buildScrollMap;
