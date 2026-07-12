/* DOM post-passes shared by the live preview and every export, applied to a
   container that already holds sanitized pipeline HTML:
     - [TOC] paragraph → nav.toc built from the outline
     - figure/table captioning + numbering, {#fig:id} anchors
     - resolve .xref placeholders (fig:/tbl:/sec:)
     - optional heading numbering (real text spans — survives Word copy)
     - colophon-asset: image resolution (blob URL live, data URI for export)
     - code copy buttons + language badges (live preview only)
   All content inserted here is either escaped text or built via createElement —
   nothing raw flows in. */

export function applyPostDom(container, { outline = [], meta = {}, resolveAsset = null, forExport = false } = {}) {
  const doc = container.ownerDocument;

  /* ---- heading numbering (h2 = 1., h3 = 1.1, h4 = 1.1.1) ---- */
  const secNums = new Map();          // heading id → "2.1"
  if (meta.numberHeadings === true) {
    const counters = [0, 0, 0];
    for (const h of container.querySelectorAll('h2, h3, h4')) {
      if (h.closest('.references, .footnotes, nav.toc')) continue;
      const lvl = +h.tagName[1] - 2;
      counters[lvl]++;
      for (let i = lvl + 1; i < 3; i++) counters[i] = 0;
      const label = counters.slice(0, lvl + 1).join('.');
      const span = doc.createElement('span');
      span.className = 'hnum';
      span.textContent = label + (lvl === 0 ? '.' : '');
      h.prepend(span);
      if (h.id) secNums.set(h.id, label);
    }
  }

  /* ---- figures: lone image in a paragraph, alt text becomes the caption ---- */
  /* All three passes below only consider TOP-LEVEL paragraphs: a "[TOC]" or
     "Table:" line quoted inside a blockquote/list is content, not a directive. */
  const topPs = () => [...container.querySelectorAll('p')].filter(p => p.parentElement === container);

  let figN = 0;
  const figNums = new Map();          // "fig:xyz" → number
  for (const p of topPs()) {
    const img = p.children.length === 1 && p.children[0].tagName === 'IMG' ? p.children[0] : null;
    if (!img) continue;
    // A pandoc/Quarto-style attribute block after the image ends up as trailing
    // text: {#fig:id} | {#fig:id width=50%} | {width=75%}. Parse an optional
    // #fig-label and an optional width=<n>(%|px) — nothing else is honored.
    let figId = null, figWidth = null;
    const trail = (p.textContent || '').trim();
    const attrM = trail.match(/^\{\s*(#fig[:.][\w:.-]+)?\s*(?:width=(\d+(?:%|px)?))?\s*\}$/i);
    if (attrM && (attrM[1] || attrM[2])) {
      if (attrM[1]) figId = attrM[1].slice(1).replace('.', ':');
      if (attrM[2]) figWidth = /%|px$/.test(attrM[2]) ? attrM[2] : attrM[2] + 'px';
    }
    const alt = img.getAttribute('alt') || '';
    if (!alt && !figId && !figWidth) continue;          // plain image, leave as-is
    figN++;
    if (figId) figNums.set(figId, figN);
    const fig = doc.createElement('figure');
    if (figId) fig.id = figId.replace(':', '-');
    const imgClone = img.cloneNode(true);
    if (figWidth) imgClone.setAttribute('style', 'width:' + figWidth + ';max-width:100%');
    fig.appendChild(imgClone);
    const cap = doc.createElement('figcaption');
    const no = doc.createElement('span');
    no.className = 'fig-no';
    no.textContent = 'Figure ' + figN + '.';
    cap.appendChild(no);
    cap.appendChild(doc.createTextNode(' ' + alt));
    if (alt || figId) fig.appendChild(cap);
    p.replaceWith(fig);
  }

  /* ---- table captions: a paragraph starting "Table: " right before a table ---- */
  let tblN = 0;
  const tblNums = new Map();
  for (const p of topPs()) {
    const m = (p.textContent || '').match(/^Table:\s+(.*)$/s);
    if (!m) continue;
    let next = p.nextElementSibling;
    if (!next || next.tagName !== 'TABLE') continue;
    tblN++;
    let text = m[1].trim(), tblId = null;
    const idM = text.match(/\{#(tbl[:.][\w:.-]+)\}\s*$/);
    if (idM) { tblId = idM[1].replace('.', ':'); tblNums.set(tblId, tblN); text = text.slice(0, idM.index).trim(); }
    const cap = doc.createElement('p');
    cap.className = 'tbl-caption';
    if (tblId) cap.id = tblId.replace(':', '-');
    const no = doc.createElement('span');
    no.className = 'fig-no';
    no.textContent = 'Table ' + tblN + '.';
    cap.appendChild(no);
    cap.appendChild(doc.createTextNode(' ' + text));
    next.before(cap);
    p.remove();
  }

  /* ---- resolve cross-reference placeholders ---- */
  for (const x of container.querySelectorAll('span.xref')) {
    const target = (x.getAttribute('data-xref') || '').replace('.', ':').replace(/^table:/, 'tbl:');
    const a = doc.createElement('a');
    a.className = 'eqref';
    let text = null;
    if (figNums.has(target)) { text = 'Figure ' + figNums.get(target); a.href = '#' + target.replace(':', '-'); }
    else if (tblNums.has(target)) { text = 'Table ' + tblNums.get(target); a.href = '#' + target.replace(':', '-'); }
    else if (target.startsWith('sec:')) {
      const id = target.slice(4);
      const h = container.querySelector('#' + (doc.defaultView?.CSS ?? CSS).escape(id));
      if (h) { text = secNums.has(id) ? '§' + secNums.get(id) : '“' + h.textContent.replace(/^\s*[\d.]+\s*/, '').trim() + '”'; a.href = '#' + id; }
    }
    if (text) { a.textContent = text; x.replaceWith(a); }
    else { x.classList.add('cite-unresolved'); x.title = 'unresolved reference: ' + target; x.textContent = '(?)'; }
  }

  /* ---- [TOC] ---- */
  const tocTargets = topPs().filter(p => /^\[(TOC|\[toc\])\]$/i.test((p.textContent || '').trim()));
  if (tocTargets.length) {
    const items = outline.filter(h => h.level >= 2 && h.level <= 4);
    for (const p of tocTargets) {
      if (!items.length) { p.remove(); continue; }
      const nav = doc.createElement('nav');
      nav.className = 'toc';
      const title = doc.createElement('div');
      title.className = 'toc-title';
      title.textContent = 'Contents';
      nav.appendChild(title);
      const stack = [{ level: 1, ol: doc.createElement('ol') }];
      nav.appendChild(stack[0].ol);
      for (const h of items) {
        while (stack.length > 1 && stack[stack.length - 1].level >= h.level) stack.pop();
        while (stack[stack.length - 1].level < h.level - 1) {
          const ol = doc.createElement('ol');
          const parent = stack[stack.length - 1].ol;
          (parent.lastElementChild || parent.appendChild(doc.createElement('li'))).appendChild(ol);
          stack.push({ level: stack[stack.length - 1].level + 1, ol });
        }
        const li = doc.createElement('li');
        const a = doc.createElement('a');
        a.href = '#' + h.id;
        a.textContent = (secNums.has(h.id) ? secNums.get(h.id) + '  ' : '') + h.text;
        li.appendChild(a);
        stack[stack.length - 1].ol.appendChild(li);
        if (stack[stack.length - 1].level !== h.level) stack.push({ level: h.level, ol: stack[stack.length - 1].ol });
      }
      p.replaceWith(nav);
    }
  }

  /* ---- images stored in the local library (colophon-asset:) ---- */
  if (resolveAsset) {
    for (const img of container.querySelectorAll('img[src^="colophon-asset:"]')) {
      const id = img.getAttribute('src').slice('colophon-asset:'.length);
      const url = resolveAsset(id, { forExport });
      if (url && typeof url === 'string') img.setAttribute('src', url);
      else if (url && typeof url.then === 'function') { /* async data-URI fill for export */ }
      else { img.setAttribute('alt', (img.getAttribute('alt') || '') + ' [missing local image]'); img.removeAttribute('src'); }
    }
  }

  /* ---- code affordances (live preview only) ---- */
  if (!forExport) {
    for (const wrap of container.querySelectorAll('.code-wrap')) {
      if (wrap.querySelector('.code-tools')) continue;
      const tools = doc.createElement('div');
      tools.className = 'code-tools';
      const lang = wrap.getAttribute('data-lang');
      if (lang && lang !== 'plaintext' && lang !== 'text') {
        const badge = doc.createElement('span');
        badge.className = 'code-lang';
        badge.textContent = lang;
        tools.appendChild(badge);
      }
      const btn = doc.createElement('button');
      btn.className = 'code-copy';
      btn.type = 'button';
      btn.textContent = 'copy';
      btn.setAttribute('data-copy', '1');
      tools.appendChild(btn);
      wrap.appendChild(tools);
    }
  } else {
    for (const t of container.querySelectorAll('.code-tools')) t.remove();
  }

  return { figures: figN, tables: tblN };
}
