/* Mermaid diagrams — lazy engine, live-preview transform, export transform.

   Mermaid ships in the page as a ~3.4 MB text/plain blob (#vendor-mermaid) that
   costs nothing at startup. The first time a document actually contains a
   ```mermaid fence we inject that blob as a real <script>. If injection is
   blocked (CSP / eval-less host such as some artifact sandboxes) we degrade
   gracefully: the fence stays a code block and a one-time toast explains why.

   SANITIZER EXCEPTION: mermaid output SVG is injected via innerHTML. This is the
   single documented exception to Colophon's "createElement/textContent or sanitize()"
   rule — mermaid is initialised with securityLevel:'strict', so it strips scripts
   and event handlers from its own output before we ever see it. Every injection
   site below is commented. */

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** @param {{ getTheme:()=>string, onUnavailable?:()=>void }} deps */
export function createMermaid({ getTheme, onUnavailable } = {}) {
  let engine = null;              // null | 'ready' | 'unavailable'
  let notified = false;
  let idc = 0;
  const cache = new Map();        // source hash → svg string

  function themeName() { return (getTheme && getTheme()) === 'slate' ? 'dark' : 'neutral'; }

  function ensure() {
    if (engine) return engine;
    try {
      if (typeof window !== 'undefined' && window.mermaid) engine = 'ready';
      else {
        const src = typeof document !== 'undefined'
          && document.getElementById('vendor-mermaid') && document.getElementById('vendor-mermaid').textContent;
        if (!src) { engine = 'unavailable'; }
        else {
          const s = document.createElement('script');
          s.textContent = src;                     // inline scripts execute synchronously on append
          document.head.appendChild(s);
          engine = (typeof window !== 'undefined' && window.mermaid) ? 'ready' : 'unavailable';
        }
      }
      if (engine === 'ready') {
        window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: themeName(), fontFamily: 'inherit' });
      }
    } catch { engine = 'unavailable'; }
    if (engine === 'unavailable' && !notified) { notified = true; if (onUnavailable) onUnavailable(); }
    return engine;
  }

  function mermaidBlocks(container) {
    const seen = new Set();
    const wraps = [];
    for (const code of container.querySelectorAll('code.language-mermaid, .code-wrap[data-lang="mermaid"] code, pre code.language-mermaid')) {
      const wrap = code.closest('.code-wrap') || code.closest('pre');
      if (!wrap || seen.has(wrap)) continue;
      seen.add(wrap);
      wraps.push({ wrap, src: code.textContent.replace(/\n$/, '') });
    }
    return wraps;
  }

  function svgToWrap(src, svg) {
    const div = document.createElement('div');
    div.className = 'mermaid-wrap';
    div.setAttribute('data-src', src);           // original source kept for re-edit / DOCX fallback
    // SANITIZER EXCEPTION (see file header): trusted mermaid strict-mode SVG.
    div.innerHTML = svg;
    return div;
  }
  function errorToWrap(src, err, wrap) {
    const div = document.createElement('div');
    div.className = 'mermaid-error';
    const note = document.createElement('div');
    note.className = 'err-note';
    const msg = (err && err.message) ? String(err.message).split('\n')[0] : 'could not render';
    note.textContent = 'Diagram error — ' + msg;
    div.appendChild(note);
    div.appendChild(wrap.cloneNode(true));       // preserve the original code block
    return div;
  }
  function cleanupTemp(id) {
    try {
      for (const sel of ['#' + id, '#d' + id]) {
        const n = document.querySelector(sel);
        if (n && n.parentNode === document.body) n.remove();
      }
    } catch { /* ignore */ }
  }

  /** Transform mermaid fences inside `container`. Cached diagrams are injected
      synchronously (no flash); misses render async. `isStale()` (optional) lets a
      live preview abort injection if a newer render superseded this one. */
  async function transform(container, { isStale = null } = {}) {
    const blocks = mermaidBlocks(container);
    if (!blocks.length) return;
    if (ensure() !== 'ready') return;            // leave fences as code blocks
    for (const { wrap, src } of blocks) {
      if (!wrap.isConnected && container.isConnected) continue;
      const hit = cache.get(hashStr(src));
      if (hit !== undefined) { wrap.replaceWith(svgToWrap(src, hit)); continue; }
      wrap.classList.add('mermaid-pending');           // dim the source while it renders
      const id = 'colophon-mmd-' + (++idc);
      let svg = null, error = null;
      try { svg = (await window.mermaid.render(id, src)).svg; }
      catch (e) { error = e; }
      cleanupTemp(id);
      if (isStale && isStale()) return;          // a newer preview render won — drop this result
      if (svg != null) { cache.set(hashStr(src), svg); wrap.replaceWith(svgToWrap(src, svg)); }
      else wrap.replaceWith(errorToWrap(src, error, wrap));
    }
  }

  return {
    transform,
    isReady: () => ensure() === 'ready',
    available: () => engine !== 'unavailable',
    /** Re-theme: clear the cache and re-initialise so diagrams re-render. */
    setTheme() { cache.clear(); if (engine === 'ready') { try { window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: themeName(), fontFamily: 'inherit' }); } catch { /* ignore */ } } },
  };
}
