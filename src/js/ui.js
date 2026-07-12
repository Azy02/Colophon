/* UI chrome: toasts, the generic dialog, the library & outline panels, the
   sidebar tabs, the find/replace bar, and the version-history dialog. Everything
   user-supplied (document names, version text) is inserted via textContent /
   createElement — the only innerHTML here takes trusted, author-written markup. */

import { buildLibTree } from './libtree.js';

const q = (id) => document.getElementById(id);

/* ---------- undo-preserving editor edits (shared by commands, LaTeX import, find) ----------
   execCommand('insertText') keeps the textarea's native undo stack intact and
   fires an 'input' event itself; the setRangeText fallback dispatches one. */
export function applyEdit(el, start, end, text, sel) {
  el.focus();
  el.setSelectionRange(start, end);
  let ok = false;
  try { ok = document.execCommand && document.execCommand('insertText', false, text); }
  catch { ok = false; }
  if (!ok) {
    el.setRangeText(text, start, end, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (sel) el.setSelectionRange(sel[0], sel[1]);
}

/* ---------- relative time ---------- */
export function relTime(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return Math.max(1, Math.floor(s / 60)) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 604800) return Math.floor(s / 86400) + 'd ago';
  return new Date(ts).toLocaleDateString();
}

/* ---------- toasts ----------
   Design goals (user feedback): never pile up, never show a wall of them,
   always dismissible, and don't vanish before you can read them.
     · the stack is capped (MAX_TOASTS) — a new toast evicts the oldest;
     · an identical message that's already showing is REFRESHED, not duplicated
       (repeated saves/renders don't stack);
     · every toast has a × and hovering it pauses the auto-dismiss countdown;
     · durations scale with importance and message length; errors persist until
       dismissed (timeout 0) since a failure you missed is worse than clutter. */
const MAX_TOASTS = 3;
const liveToasts = [];   // {el, msg, refresh}
export function toast(msg, opts = {}) {
  const host = q('toasts');
  if (!host) return { dismiss() {} };

  // dedupe: same text already up → just restart its timer (and update action)
  const dup = liveToasts.find((x) => x.msg === msg && !x.el._gone);
  if (dup) { dup.refresh(); return { dismiss: dup.dismiss }; }

  const t = document.createElement('div');
  t.className = 'toast' + (opts.kind ? ' ' + opts.kind : '');
  const text = document.createElement('span'); text.className = 'toast-msg'; text.textContent = msg;
  t.appendChild(text);
  if (opts.actionLabel && opts.onAction) {
    const b = document.createElement('button');
    b.className = 'linklike'; b.type = 'button'; b.textContent = opts.actionLabel;
    b.addEventListener('click', () => { try { opts.onAction(); } finally { dismiss(); } });
    t.appendChild(b);
  }
  const x = document.createElement('button');
  x.className = 'toast-x'; x.type = 'button'; x.setAttribute('aria-label', 'Dismiss'); x.textContent = '×';
  x.addEventListener('click', () => dismiss());
  t.appendChild(x);

  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));

  // length-aware base: errors persist (0), actions linger, plain info scales
  // with reading time (~1s per 12 chars, clamped 4–9s)
  const readMs = Math.min(9000, Math.max(4000, msg.length * 80));
  const base = opts.kind === 'error' ? 0 : (opts.actionLabel ? Math.max(6000, readMs) : readMs);
  const timeout = opts.timeout === undefined ? base : opts.timeout;

  let timer = null;
  const arm = () => { if (timeout && timeout > 0) { clearTimeout(timer); timer = setTimeout(dismiss, timeout); } };
  function dismiss() {
    if (t._gone) return;
    t._gone = true;
    clearTimeout(timer);
    const i = liveToasts.findIndex((x) => x.el === t);
    if (i >= 0) liveToasts.splice(i, 1);
    t.classList.remove('show');
    setTimeout(() => t.remove(), 250);
  }
  function refresh() { t.classList.add('show'); arm(); }
  // hovering pauses the countdown so a toast you're reading can't slip away
  t.addEventListener('pointerenter', () => clearTimeout(timer));
  t.addEventListener('pointerleave', arm);
  arm();

  liveToasts.push({ el: t, msg, refresh, dismiss });
  while (liveToasts.length > MAX_TOASTS) liveToasts[0].dismiss();   // evict oldest
  return { dismiss };
}

/* ---------- backdrop (shared by palette + dialog) ---------- */
export function showBackdrop(on) { const b = q('backdrop'); if (b) b.hidden = !on; }

/* ---------- generic dialog with focus trap + Esc ---------- */
let dialogState = null;
export function isDialogOpen() { return !!dialogState; }

export function openDialog({ title, body, onClose, initialFocus } = {}) {
  closeDialog();
  const dlg = q('dialog'), titleEl = q('dialogTitle'), bodyEl = q('dialogBody');
  titleEl.textContent = title || '';
  bodyEl.replaceChildren();
  if (typeof body === 'string') bodyEl.innerHTML = body;   // trusted static markup only
  else if (body) bodyEl.appendChild(body);
  showBackdrop(true);
  document.body.classList.add('dialog-open');   // narrow layouts: lift the backdrop above the sidebar drawer
  dlg.hidden = false;
  const prevFocus = document.activeElement;
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeDialog(); }
    else if (e.key === 'Tab') trapTab(dlg, e);
  };
  dlg.addEventListener('keydown', onKey);
  dialogState = { dlg, onKey, onClose, prevFocus };
  const focusTarget = (initialFocus && bodyEl.querySelector(initialFocus))
    || bodyEl.querySelector('input, select, textarea, button') || q('dialogClose');
  if (focusTarget) focusTarget.focus();
  return { close: closeDialog };
}

export function closeDialog() {
  if (!dialogState) return;
  const { dlg, onKey, onClose, prevFocus } = dialogState;
  dialogState = null;
  dlg.removeEventListener('keydown', onKey);
  dlg.hidden = true;
  document.body.classList.remove('dialog-open');
  showBackdrop(false);
  if (onClose) { try { onClose(); } catch { /* ignore */ } }
  if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch { /* ignore */ } }
}

function trapTab(container, e) {
  const focusables = [...container.querySelectorAll(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((el) => el.offsetParent !== null || el === document.activeElement);
  if (!focusables.length) return;
  const first = focusables[0], last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/* ---------- library list ----------
   Browser library: a flat doc list. Folder project: a tree — root docs, then
   one collapsible group per top-level subfolder (figs/, refs/, …) holding its
   docs and assets (figures/PDFs). Entries keep FULL relative paths in
   data-name/data-asset; labels drop the group prefix. */
export function renderLibrary(listEl, docs, opts = {}) {
  const { currentName, folderMode = false, filter = '', onOpen, onDelete, onRename,
          assets = [], collapsedDirs, onToggleDir, onAsset } = opts;
  listEl.replaceChildren();
  const f = filter.trim().toLowerCase();
  const match = (n) => !f || n.toLowerCase().includes(f);
  const docLi = (d, label) => {
    const li = document.createElement('li');
    li.dataset.name = d.name;
    li.tabIndex = 0;   // focusable → keyboard shortcuts (⌘C/⌘V/⌘D/⌘⌫, arrows) target it
    if (d.name === currentName) li.classList.add('active');
    const nm = document.createElement('span');
    nm.className = 'nm'; nm.textContent = label || d.name; nm.title = d.name;
    li.appendChild(nm);
    if (d.mtime) {
      const when = document.createElement('span');
      when.className = 'when'; when.textContent = relTime(d.mtime);
      li.appendChild(when);
    }
    li.addEventListener('click', () => onOpen && onOpen(d.name));
    nm.addEventListener('dblclick', (e) => { e.stopPropagation(); onRename && onRename(d.name); });
    if (onDelete) {
      const del = document.createElement('button');
      del.className = 'del'; del.type = 'button'; del.textContent = '×';
      del.title = 'Delete document'; del.setAttribute('aria-label', 'Delete ' + d.name);
      del.addEventListener('click', (e) => { e.stopPropagation(); onDelete(d.name); });
      li.appendChild(del);
    }
    return li;
  };
  const assetLi = (a, label) => {
    const li = document.createElement('li');
    li.className = 'lib-asset';
    li.dataset.asset = a.name;
    li.tabIndex = 0;   // keyboard users reach assets too: arrows traverse, Enter views
    const ic = document.createElement('span');
    ic.className = 'lib-asset-ic'; ic.textContent = /\.pdf$/i.test(a.name) ? '📄' : '🖼';
    const nm = document.createElement('span');
    nm.className = 'nm'; nm.textContent = label || a.name;
    nm.title = a.name + ' — click to view; right-click for more';
    li.append(ic, nm);
    li.addEventListener('click', () => onAsset && onAsset(a.name));
    return li;
  };
  const shownDocs = docs.filter((d) => match(d.name));
  const shownAssets = folderMode ? assets.filter((a) => match(a.name)) : [];
  if (!shownDocs.length && !shownAssets.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = f ? 'No documents match that filter.'
      : folderMode ? 'No .md files in the linked folder.'
      : 'No documents yet — drag .md or .bib files onto this window.';
    listEl.appendChild(li);
    return;
  }
  if (!folderMode) {
    for (const d of shownDocs) listEl.appendChild(docLi(d));
    return;
  }
  const tree = buildLibTree([
    ...shownDocs.map((d) => ({ ...d, kind: 'doc' })),
    ...shownAssets.map((a) => ({ ...a, kind: 'asset' })),
  ]);
  for (const d of tree.rootDocs) listEl.appendChild(docLi(d));
  for (const a of tree.rootAssets) listEl.appendChild(assetLi(a));
  for (const g of tree.groups) {
    const folded = !f && collapsedDirs && collapsedDirs.has(g.dir);   // filtering opens everything
    const head = document.createElement('li');
    head.className = 'lib-dir'; head.tabIndex = 0;
    head.setAttribute('role', 'button');
    head.setAttribute('aria-expanded', String(!folded));
    const tri = document.createElement('span');
    tri.className = 'tri'; tri.textContent = folded ? '▸' : '▾';
    const nm = document.createElement('span');
    nm.className = 'nm'; nm.textContent = g.dir; nm.title = g.dir + '/';
    const ct = document.createElement('span');
    ct.className = 'when'; ct.textContent = String(g.count);
    head.append(tri, nm, ct);
    const toggle = () => onToggleDir && onToggleDir(g.dir);
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    listEl.appendChild(head);
    if (folded) continue;
    const holder = document.createElement('li');
    holder.className = 'lib-sub-holder';
    const sub = document.createElement('ul');
    sub.className = 'lib-sub';
    const strip = (n) => n.slice(g.dir.length + 1);
    for (const d of g.docs) sub.appendChild(docLi(d, strip(d.name)));
    for (const a of g.assets) sub.appendChild(assetLi(a, strip(a.name)));
    holder.appendChild(sub);
    listEl.appendChild(holder);
  }
}

/* ---------- outline list ---------- */
export function renderOutline(listEl, outline, opts = {}) {
  const emptyEl = q('outlineEmpty');
  listEl.replaceChildren();
  const items = (outline || []).filter((h) => h.level >= 1 && h.level <= 6 && h.id);
  if (emptyEl) emptyEl.hidden = items.length > 0;
  for (const h of items) {
    const li = document.createElement('li');
    li.dataset.l = h.level; li.dataset.id = h.id;
    li.textContent = h.text; li.title = h.text;
    li.addEventListener('click', () => opts.onClick && opts.onClick(h.id));
    listEl.appendChild(li);
  }
}
export function highlightOutline(listEl, id) {
  for (const li of listEl.children) li.classList.toggle('current', li.dataset.id === id);
}

/* ---------- sidebar tabs + open/close (persisted) ---------- */
export function initSidebar(opts = {}) {
  const main = q('main'), tabLib = q('tabLibrary'), tabOut = q('tabOutline'),
        panelLib = q('panelLibrary'), panelOut = q('panelOutline');
  function setTab(which) {
    const lib = which !== 'outline';
    tabLib.classList.toggle('active', lib); tabLib.setAttribute('aria-selected', String(lib));
    tabOut.classList.toggle('active', !lib); tabOut.setAttribute('aria-selected', String(!lib));
    panelLib.hidden = !lib; panelOut.hidden = lib;
    try { localStorage.setItem('colophon-sidebar-tab', lib ? 'library' : 'outline'); } catch { /* ignore */ }
    if (opts.onTab) opts.onTab(lib ? 'library' : 'outline');
  }
  function setOpen(open) {
    main.classList.toggle('with-sidebar', open);
    try { localStorage.setItem('colophon-sidebar', open ? '1' : '0'); } catch { /* ignore */ }
    if (opts.onToggle) opts.onToggle(open);
  }
  function toggle() { setOpen(!main.classList.contains('with-sidebar')); }
  tabLib.addEventListener('click', () => setTab('library'));
  tabOut.addEventListener('click', () => setTab('outline'));
  q('btnSidebar').addEventListener('click', toggle);
  q('btnSidebarClose').addEventListener('click', () => setOpen(false));
  let open = true; try { open = localStorage.getItem('colophon-sidebar') !== '0'; } catch { /* ignore */ }
  setOpen(open);
  let tab = 'library'; try { tab = localStorage.getItem('colophon-sidebar-tab') || 'library'; } catch { /* ignore */ }
  setTab(tab);
  return { setTab, setOpen, toggle };
}

/* ---------- find & replace bar (operates on the textarea) ---------- */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function scrollMatchIntoView(el, index) {
  const line = el.value.slice(0, index).split('\n').length - 1;
  const cs = getComputedStyle(el);
  const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 14) * 1.6;
  const padTop = parseFloat(cs.paddingTop) || 0;
  const target = line * lh + padTop;
  const view = el.clientHeight;
  if (target < el.scrollTop + lh || target > el.scrollTop + view - 2 * lh) {
    el.scrollTop = Math.max(0, target - view / 3);
  }
}

export function createFindbar(editor) {
  const bar = q('findbar'), input = q('findInput'), rInput = q('replaceInput'),
        countEl = q('findCount'), btnNext = q('findNext'), btnPrev = q('findPrev'),
        btnOne = q('replaceOne'), btnAll = q('replaceAll'), btnClose = q('findClose');
  let matches = [], cur = -1;

  function search(keepCur) {
    const term = input.value;
    matches = [];
    if (term) {
      const re = new RegExp(escapeRegExp(term), 'gi');
      const text = editor.value; let m;
      while ((m = re.exec(text))) { matches.push(m.index); if (m.index === re.lastIndex) re.lastIndex++; }
    }
    if (!keepCur || cur >= matches.length) cur = matches.length ? 0 : -1;
    updateCount();
  }
  function updateCount() { countEl.textContent = matches.length ? (cur + 1) + '/' + matches.length : '0/0'; }
  function show(index) {
    if (!matches.length) { updateCount(); return; }
    cur = (index + matches.length) % matches.length;
    const start = matches[cur];
    editor.focus();
    editor.setSelectionRange(start, start + input.value.length);
    scrollMatchIntoView(editor, start);
    updateCount();
  }
  const next = () => show(cur + 1);
  const prev = () => show(cur - 1);
  function replaceOne() {
    if (cur < 0 || !matches.length) return;
    const start = matches[cur];
    applyEdit(editor, start, start + input.value.length, rInput.value);
    search(true);
    if (matches.length) show(Math.min(cur, matches.length - 1));
  }
  function replaceAll() {
    if (!input.value || !matches.length) return;
    const n = matches.length;
    const re = new RegExp(escapeRegExp(input.value), 'gi');
    const out = editor.value.replace(re, () => rInput.value);
    applyEdit(editor, 0, editor.value.length, out);
    search(false);
    toast('Replaced ' + n + (n === 1 ? ' match' : ' matches'));
  }
  function open() {
    bar.hidden = false;
    const sel = editor.value.slice(editor.selectionStart, editor.selectionEnd);
    if (sel && !sel.includes('\n')) input.value = sel;
    search(false);
    input.focus(); input.select();
  }
  function close() { bar.hidden = true; editor.focus(); }
  const isOpen = () => !bar.hidden;
  /** Re-run the search against the editor's CURRENT content — for programmatic
      content swaps (document switch) that fire no `input` event; without this
      the bar shows the previous document's stale match count. */
  function refresh() { if (isOpen()) search(false); }

  input.addEventListener('input', () => search(false));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? prev() : next(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  rInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); replaceOne(); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  btnNext.addEventListener('click', next);
  btnPrev.addEventListener('click', prev);
  btnOne.addEventListener('click', replaceOne);
  btnAll.addEventListener('click', replaceAll);
  btnClose.addEventListener('click', close);
  editor.addEventListener('input', () => { if (isOpen()) search(true); });

  return { open, close, isOpen, refresh };
}

/* ---------- version-history dialog ---------- */
export async function openVersionHistory(name, { versionsList, onRestore }) {
  const versions = await versionsList(name);
  const wrap = document.createElement('div');
  if (!versions.length) {
    const p = document.createElement('p');
    p.textContent = 'No saved versions yet. Colophon snapshots a version on every save, before a LaTeX conversion, and before deleting a document.';
    wrap.appendChild(p);
  } else {
    const ul = document.createElement('ul');
    ul.className = 'vlist';
    for (const v of versions) {
      const li = document.createElement('li');
      const when = document.createElement('span');
      when.className = 'when'; when.textContent = new Date(v.ts).toLocaleString();
      const reason = document.createElement('span');
      reason.className = 'reason'; reason.textContent = v.reason || 'save';
      const grow = document.createElement('span');
      grow.className = 'grow';
      const preview = document.createElement('span');
      preview.className = 'reason';
      const snippet = String(v.content || '').replace(/\s+/g, ' ').trim();
      preview.textContent = snippet.slice(0, 90);
      preview.title = snippet.slice(0, 500);
      grow.appendChild(preview);
      const btn = document.createElement('button');
      btn.className = 'btn small'; btn.type = 'button'; btn.textContent = 'Restore';
      btn.addEventListener('click', async () => { await onRestore(v); closeDialog(); });
      li.append(when, reason, grow, btn);
      ul.appendChild(li);
    }
    wrap.appendChild(ul);
  }
  openDialog({ title: 'Version history — ' + name, body: wrap });
}

/* ---------- small helper: a labelled action-row button set for dialogs ---------- */
export function dialogActions(buttons) {
  const row = document.createElement('div');
  row.className = 'dialog-actions';
  for (const b of buttons) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'btn' + (b.primary ? ' primary' : '');
    el.textContent = b.label;
    el.addEventListener('click', b.onClick);
    row.appendChild(el);
  }
  return row;
}
