/* The single sanitization gate. Every string that reaches innerHTML — live
   preview or any export — passes through sanitize(). DOMPurify with HTML +
   MathML + SVG profiles (KaTeX emits spans + MathML + stretchy-delimiter SVG;
   callouts embed octicon SVGs), plus a per-tag URL policy:
     <a href>    → https, http, mailto, #fragment only
     <img src>   → https, http, data:image/*, colophon-asset: only
   iframes/objects/forms and every on* handler are gone; <input> survives only
   as a disabled checkbox (GFM task lists). */

import createDOMPurify from 'dompurify';

let purify = null;

/* Remote images are blocked by default (a hostile .md must not beacon home the
   moment it's opened — "nothing leaves this machine" is a product promise).
   The app offers a per-document "Load remote images" action that flips this,
   re-renders, and resets on document switch. */
let allowRemoteImages = false;
export function setAllowRemoteImages(v) { allowRemoteImages = !!v; }
export function getAllowRemoteImages() { return allowRemoteImages; }

/* Shape rule for the data-local-src / data-local-href stashes: relative-only —
   no scheme, no absolute or protocol-relative path, and no '..' segment (raw
   OR %-encoded: the folder reader decodes before resolving, and exportHtml
   promotes these stashes back to live href/src in the standalone export, so a
   traversal must be rejected here, not just at the in-app consumers). */
function isLocalRelPath(p) {
  if (!p || /^[a-z][a-z0-9+.-]*:/i.test(p) || /^([/\\#]|\/\/)/.test(p)) return false;
  let dec = p; try { dec = decodeURIComponent(p); } catch { /* keep raw */ }
  return !/(^|[/\\])\.\.([/\\]|$)/.test(p) && !/(^|[/\\])\.\.([/\\]|$)/.test(dec);
}

export function initSanitizer(win) {
  purify = createDOMPurify(win);

  purify.addHook('afterSanitizeAttributes', (node) => {
    const tag = node.tagName;
    // A stash attribute arriving IN the input (raw HTML inside the markdown,
    // or a re-sanitize of already-stashed content) never went through the
    // shape checks below — validate it here or drop it, so nothing downstream
    // (folder reader, export promotion) can ever see an unvetted stash value.
    for (const attr of ['data-local-href', 'data-local-src']) {
      const v = node.getAttribute && node.getAttribute(attr);
      if (v != null && !isLocalRelPath(v.trim())) node.removeAttribute(attr);
    }
    if (tag === 'A') {
      const href = node.getAttribute('href') || '';
      if (href && !/^(https?:|mailto:|#)/i.test(href.trim())) {
        node.removeAttribute('href');
        // A RELATIVE link (same shape rule as data-local-src below) refers to
        // a file in the user's project — most usefully a PDF. Preserve it as
        // INERT data, exactly like the img stash: it never re-enters href;
        // the preview's click handler resolves it through the folder reader
        // ('..' rejected) into the in-app viewer.
        const h0 = href.trim();
        if (isLocalRelPath(h0)) node.setAttribute('data-local-href', h0);
      }
      const h = node.getAttribute('href') || '';
      if (/^https?:/i.test(h)) { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
    }
    if (tag === 'IMG') {
      const src = (node.getAttribute('src') || '').trim();
      if (!/^(https?:|colophon-asset:|data:image\/(png|jpe?g|gif|webp|svg\+xml|avif);)/i.test(src)) {
        node.removeAttribute('src');
        // A RELATIVE path (no scheme, not protocol-relative, not site-absolute)
        // references a file in the user's linked project folder. Preserve it as
        // INERT data — same stash pattern as data-remote-src below. It never
        // re-enters src here; the folder resolver reads it, walks the project
        // folder ('..' rejected), and swaps in a blob: URL it created itself.
        if (isLocalRelPath(src)) node.setAttribute('data-local-src', src);
      } else if (/^https?:/i.test(src) && !allowRemoteImages) {
        node.setAttribute('data-remote-src', src);
        node.removeAttribute('src');
      }
    }
    if (tag === 'INPUT') {
      if ((node.getAttribute('type') || '').toLowerCase() !== 'checkbox') { node.remove(); return; }
      node.setAttribute('disabled', '');
    }
  });
  return purify;
}

const CONFIG = {
  USE_PROFILES: { html: true, mathMl: true, svg: true },
  ADD_TAGS: ['semantics', 'annotation'],
  ADD_ATTR: ['data-remote-src', 'data-local-src', 'data-local-href', 'data-tex', 'data-display', 'data-lang', 'data-xref', 'data-footnote-ref',
             'data-footnote-backref', 'data-footnotes', 'data-mermaid', 'data-line',
             'encoding', 'target', 'rel', 'accent', 'movablelimits'],
  /* Internal, trusted data-* attributes whose values legitimately contain a
     colon — data-xref carries "fig:setup"/"tbl:x"/"sec:y", data-tex carries
     math like "a : b" or "\{x : x>0\}". Without this, DOMPurify runs the
     href/src ALLOWED_URI_REGEXP against them (any colon value is scrutinized),
     sees an unknown "fig:"-style scheme, and silently strips the attribute —
     which broke every figure/table cross-reference (rendered "(?)") and would
     corrupt colon-bearing equations. These attributes are never navigated to
     (they're read by our own postdom/exporter code), so skipping URI checks on
     them is safe. */
  ADD_URI_SAFE_ATTR: ['data-xref', 'data-tex'],
  FORBID_TAGS: ['style', 'noscript', 'iframe', 'object', 'embed', 'form', 'base', 'meta', 'link', 'audio', 'video', 'dialog', 'slot', 'template'],
  FORBID_ATTR: ['formaction', 'action', 'background', 'poster', 'srcdoc'],
  ALLOW_DATA_ATTR: false,
  /* default regexp rejects our colophon-asset: scheme before hooks run; this
     widens the gate, then the per-tag hook above narrows it again */
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|colophon-asset):|data:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml);|[^a-z+.\-:]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
};

export function sanitize(html) {
  if (!purify) {
    if (typeof window !== 'undefined') initSanitizer(window);
    else throw new Error('sanitize(): call initSanitizer(window) first');
  }
  return purify.sanitize(html, CONFIG);
}
