/* App boot + glue. Owns the central state, the debounced render loop, autosave &
   drafts, the document lifecycle, and wires the toolbar, palette, sidebar, find
   bar and exports. The ONLY raw innerHTML assignment is preview.innerHTML =
   result.html (already sanitized by the pipeline); everything else is textContent
   / createElement or trusted static markup. */

import { initSanitizer, setAllowRemoteImages, getAllowRemoteImages } from './sanitize.js';
import { render } from './pipeline.js';
import { applyPostDom } from './postdom.js';
import { parseFrontMatter } from './frontmatter.js';
import {
  docPut, docGet, docDelete, docsAll, docRename,
  draftPut, draftGet, draftClear,
  versionAdd, versionsList, versionsClear, assetGet, assetPut, assetDelete, assetsGC,
  metaPut, metaGet, storageMode, _injectIDB,
} from './store.js';
import {
  toast, openDialog, closeDialog, isDialogOpen,
  renderLibrary, renderOutline, highlightOutline, initSidebar,
  createFindbar, openVersionHistory, applyEdit, dialogActions,
} from './ui.js';
import { createCommands, createPalette, bindShortcuts, prettyKeys } from './commands.js';
import { exportMarkdown, exportHtml, exportPdf, exportWordCopy, exportDocx, exportTex, download } from './exporter.js';
import { createMermaid } from './mermaidctl.js';
import { WELCOME_MD, TEMPLATES, SEED_DOCS, SEED_ASSETS, seedHash } from './seeds.js';
import { convertLatex, looksLikeLatex } from './latexin.js';
import { serializeSelection } from './copymd.js';
import { sourceBlocks, lineOfOffset } from './blockmap.js';
import { buildScrollMap, mapScroll } from './syncmap.js';
import { DOC_RE, ASSET_RE, isSafeRelPath } from './libtree.js';
import { assetRefs, rewriteAssetRefs, bytesEqual } from './migrate.js';
import { listContinuation } from './autolist.js';
import { createEditor } from './editor.js';
import { parseBibtex, delatex } from './bibtex.js';

const q = (id) => document.getElementById(id);
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent || '');
// Pane canvas behind the floating page — one tonal step below each paper color
// so the document reads as a physical sheet (see docs/research/ui-exemplars.md).
const THEME_BG = { light: '#edebe5', sepia: '#e8e1d0', slate: '#1b1a17' };

/* ---------- DOM ---------- */
const editor = q('editor'), preview = q('preview'), previewPane = q('previewPane'),
      main = q('main'), splitter = q('splitter'), root = document.documentElement,
      fileInput = q('fileInput'),
      libListEl = q('libList'), libSearch = q('libSearch'), libInfo = q('libInfo'),
      outlineListEl = q('outlineList'),
      countsEl = q('counts'), renderInfo = q('renderInfo'), saveInfo = q('saveInfo'),
      fileLabel = q('fileLabel'), statusDot = q('statusDot'),
      exportMenu = q('exportMenu');

/* ---------- state ---------- */
const state = {
  currentName: 'untitled.md', dirty: false,
  view: 'split', theme: 'light', docStyle: 'clean', chromeMode: 'auto', citationStyle: 'numeric',
};
let docsCache = [];
let lastOutline = [], lastMeta = {}, lastHasMermaid = false;
let folderHandle = null;
/* a folder handle restored from a previous session that needs a fresh
   permission click (Chromium re-prompts per session unless the user picked
   "Allow on every visit") — reconnectFolder() promotes it to folderHandle */
let pendingFolder = null;
/* CodeMirror editor adapter (migration Phase 2) — null unless the ?cm=1 /
   localStorage colophon-cm=1 flag is on; mounted near the end of boot wiring */
let cm = null;
let hasLoaded = false;

/* ---------- settings ----------
   Toolbar quick-settings (theme/style/view) keep their own fast keys; everything
   the Settings dialog owns lives in one JSON blob ('colophon-settings'). */
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };
const EDITOR_FONTS = {
  mono: 'var(--mono)',
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  serif: 'Charter, "Bitstream Charter", "Iowan Old Style", Georgia, Cambria, "Times New Roman", serif',
};
const DEFAULT_SETTINGS = {
  editorFontSize: 14, editorFontFamily: 'mono', previewScale: 100, eqNumbering: 'auto', citationStyle: 'numeric',
  autosaveMs: 1000, spellcheck: false, appearance: 'auto',
  readingLayout: 'continuous',   // 'continuous' (no page-break seams) | 'paged' (show them)
  scrollAnchor: 'top',           // which line of the viewport the two panes keep in sync
  confirmDelete: true,           // ask before deleting a document ("don't ask again" unchecks it)
};
const SYNC_ANCHOR = { top: 0, middle: 0.5, bottom: 1 };
let settings = { ...DEFAULT_SETTINGS };
function persistSettings() { lsSet('colophon-settings', JSON.stringify(settings)); }

function loadSettings() {
  try {
    state.theme = localStorage.getItem('colophon-theme') || state.theme;
    state.docStyle = localStorage.getItem('colophon-style') || state.docStyle;
    state.view = localStorage.getItem('colophon-view') || state.view;
  } catch { /* ignore */ }
  let blob = {};
  try { blob = JSON.parse(localStorage.getItem('colophon-settings') || '{}') || {}; } catch { /* ignore */ }
  try {   // one-time migration of the legacy single keys
    if (blob.appearance == null) blob.appearance = localStorage.getItem('colophon-chrome') || undefined;
    if (blob.citationStyle == null) blob.citationStyle = localStorage.getItem('colophon-cite-style') || undefined;
  } catch { /* ignore */ }
  settings = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (blob[k] != null) settings[k] = blob[k];
  if (!['light', 'sepia', 'slate'].includes(state.theme)) state.theme = 'light';
  if (!['clean', 'paper', 'compact'].includes(state.docStyle)) state.docStyle = 'clean';
  if (!['split', 'editor', 'preview'].includes(state.view)) state.view = 'split';
  if (!['auto', 'light', 'dark'].includes(settings.appearance)) settings.appearance = 'auto';
  if (!['numeric', 'author-year'].includes(settings.citationStyle)) settings.citationStyle = 'numeric';
  if (!['auto', 'all', 'none'].includes(settings.eqNumbering)) settings.eqNumbering = 'auto';
  settings.editorFontSize = Math.min(18, Math.max(12, +settings.editorFontSize || 14));
  if (!EDITOR_FONTS[settings.editorFontFamily]) settings.editorFontFamily = 'mono';
  if (!['continuous', 'paged'].includes(settings.readingLayout)) settings.readingLayout = 'continuous';
  if (!['top', 'middle', 'bottom'].includes(settings.scrollAnchor)) settings.scrollAnchor = 'top';
  settings.previewScale = Math.min(200, Math.max(60, +settings.previewScale || 100));
  if (![500, 1000, 2000].includes(+settings.autosaveMs)) settings.autosaveMs = 1000;
  settings.spellcheck = !!settings.spellcheck;
  state.chromeMode = settings.appearance;
  state.citationStyle = settings.citationStyle;
}

const BASE_DOC_FS = { clean: 17, paper: 17.5, compact: 15 };
function applyPreviewScale() {
  const base = BASE_DOC_FS[state.docStyle] || 17;
  preview.style.setProperty('--doc-fs', (base * (settings.previewScale / 100)).toFixed(2) + 'px');
  if (typeof markSyncMapDirty === 'function') markSyncMapDirty();
  if (typeof updatePageBreaks === 'function') requestAnimationFrame(updatePageBreaks);   // heights changed → re-paginate
}
function applySettings() {
  root.style.setProperty('--editor-fs', settings.editorFontSize + 'px');
  root.style.setProperty('--editor-font', EDITOR_FONTS[settings.editorFontFamily] || EDITOR_FONTS.mono);
  applyPreviewScale();
  if (typeof reflectScale === 'function') reflectScale();   // appearance popover's slider mirrors the setting
  if (editor) editor.spellcheck = settings.spellcheck;
  state.chromeMode = settings.appearance;
  state.citationStyle = settings.citationStyle;
  if (typeof updatePageBreaks === 'function') updatePageBreaks();   // reading-layout seam on/off
}

/* ---------- view / theme / style / chrome ---------- */
function markSeg(segId, attr, val) {
  document.querySelectorAll('#' + segId + ' button').forEach((b) => b.classList.toggle('active', b.dataset[attr] === val));
}
function setView(v) { state.view = v; main.dataset.view = v; lsSet('colophon-view', v); markSeg('viewSeg', 'v', v); if (v === 'split') clampSplit(); if (typeof clearEditorHighlight === 'function') { clearEditorHighlight(); lastMirror = null; } }
function setTheme(t) { state.theme = t; applyPreviewClass(); previewPane.style.background = THEME_BG[t] || '#fff'; lsSet('colophon-theme', t); markSeg('themeSeg', 't', t); mermaid.setTheme(); if (lastHasMermaid) doRender(); }
function setStyle(s) { state.docStyle = s; applyPreviewClass(); lsSet('colophon-style', s); markSeg('styleSeg', 's', s); }
function setLayout(l) { updateSetting('readingLayout', l); markSeg('layoutSeg', 'l', l); applySettings(); }
function applyPreviewClass() { preview.className = 'paper theme-' + state.theme + ' style-' + state.docStyle; applyPreviewScale(); }
function setChrome(mode) { state.chromeMode = mode; lsSet('colophon-chrome', mode); applyChrome(); }
function applyChrome() {
  const dark = state.chromeMode === 'auto'
    ? (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches)
    : state.chromeMode === 'dark';
  root.dataset.chrome = dark ? 'dark' : 'light';
}

/* ---------- render loop ---------- */
const bibCache = new Map(), bibLoading = new Set();
function renderOpts(src) {
  let bibName = null;
  try { bibName = parseFrontMatter(src).meta.bibliography; } catch { /* ignore */ }
  let externalBib = null;
  if (bibName) {
    if (bibCache.has(bibName)) externalBib = bibCache.get(bibName);
    else if (!bibLoading.has(bibName)) {
      bibLoading.add(bibName);
      // mode-aware read: a project's .bib lives on disk, not in IDB
      readDocContent(bibName).then((content) => { bibCache.set(bibName, content || ''); bibLoading.delete(bibName); scheduleRender(); })
        .catch(() => bibLoading.delete(bibName));
    }
  }
  return { numbering: settings.eqNumbering, citationStyle: state.citationStyle, externalBib, docName: state.currentName };
}

const assetUrlCache = new Map();
function resolveAsset(id) {
  if (assetUrlCache.has(id)) return assetUrlCache.get(id);
  assetGet(id).then((a) => { if (a && a.blob) { assetUrlCache.set(id, URL.createObjectURL(a.blob)); scheduleRender(); } }).catch(() => {});
  return null;
}
function revokeAssetUrls() {
  for (const url of assetUrlCache.values()) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }
  assetUrlCache.clear();
}
/* Images that are real files in the linked folder (offline-Overleaf model):
   after each render, any <img> with a relative src is resolved to a blob URL
   from disk. Cache lives per folder, cleared on project switch. `null` marks
   a path that failed to resolve, so missing files don't retry every render. */
const folderUrlCache = new Map();                     // path → 'pending' | 'missing' | blob URL
function resolveFolderImages() {
  // the sanitizer stashes relative img srcs as inert data-local-src (they
  // never survive into src); this is the ONLY place that turns one back into
  // a src. SANITIZER-BOUNDARY NOTE: relative image paths are re-attached here
  // by trusted app code, post-sanitize. Two resolution modes:
  //   · folder mode  → a blob: URL of a file read from the project folder;
  //   · no folder    → the relative path itself, resolved NATIVELY by the
  //     browser against the document URL. On file:// and http that loads the
  //     real file sitting next to the app (offline-Overleaf, on disk) — the
  //     figure the user wants to find on disk. A local image load has no
  //     network exfiltration path (unlike remote images, still blocked), so
  //     this is safe; '..' traversal is still rejected by isFolderRelativeSrc.
  for (const img of preview.querySelectorAll('img[data-local-src]')) {
    const path = img.getAttribute('data-local-src');
    if (!isFolderRelativeSrc(path)) continue;
    if (!folderHandle) {                                 // no project folder → native relative load
      // reject path traversal even though it's the user's own doc: a pasted
      // document shouldn't probe files above the app directory
      if (!/(^|\/)\.\.(\/|$)/.test(path)) { img.setAttribute('src', path); img.removeAttribute('data-local-src'); }
      else img.setAttribute('alt', (img.getAttribute('alt') || '') + ' [blocked path: ' + path + ']');
      continue;
    }
    const hit = folderUrlCache.get(path);
    if (hit === 'pending') continue;
    if (hit === 'missing') { img.setAttribute('alt', (img.getAttribute('alt') || '') + ' [missing: ' + path + ']'); continue; }
    if (hit) { img.setAttribute('src', hit); continue; }
    folderUrlCache.set(path, 'pending');
    folderFileAt(path)
      .then((f) => { folderUrlCache.set(path, f ? URL.createObjectURL(f) : 'missing'); scheduleRender(); })
      .catch(() => { folderUrlCache.set(path, 'missing'); scheduleRender(); });
  }
}
function revokeFolderUrls() {
  for (const url of folderUrlCache.values()) {
    if (url && url !== 'pending' && url !== 'missing') try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  }
  folderUrlCache.clear();
}

/* ---------- mermaid (lazy engine; static SVG in exports) ---------- */
const mermaid = createMermaid({
  getTheme: () => state.theme,
  onUnavailable: () => toast('Diagrams are unavailable in this host'),
});
let mermaidToken = 0;

/* A .tex document renders through the LaTeX→Markdown bridge on the fly: the
   editor holds the real LaTeX source, the preview (and every export except
   the raw .tex one) shows the converted result — same converter, same one
   sanitize() gate at render. Block mirroring is disabled while active: source
   lines don't correspond to converted preview blocks. */
const isTexDoc = () => /\.(tex|latex)$/i.test(state.currentName || '');
let texPreviewOn = false;
function previewSource() {
  if (isTexDoc() && looksLikeLatex(editor.value)) {
    try { const t = convertLatexText(editor.value).text; texPreviewOn = true; return t; }
    catch { /* fall through to raw */ }
  }
  texPreviewOn = false;
  return editor.value;
}

let renderTimer = null;
function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(doRender, 130); }
function doRender() {
  const t0 = performance.now();
  const src = previewSource();
  const result = render(src, renderOpts(src));
  preview.innerHTML = result.html;                       // already sanitized by the pipeline
  applyPostDom(preview, { outline: result.outline, meta: result.meta, resolveAsset, forExport: false });
  decorateRefPdfs();                                     // live preview only — exports never carry the chip
  resolveFolderImages();                                 // folder mode: relative image paths are real files on disk
  if (result.hasMermaid) {                                // async; a later render supersedes via the token
    const token = ++mermaidToken;
    mermaid.transform(preview, { isStale: () => token !== mermaidToken }).catch(() => {});
  }
  lastOutline = result.outline; lastMeta = result.meta; lastHasMermaid = result.hasMermaid;
  renderOutline(outlineListEl, result.outline, { onClick: scrollToHeading });
  updateCounts(result);
  renderInfo.textContent = Math.round(performance.now() - t0) + ' ms';
  offerRemoteImages();
  tagPreviewBlocks();                                    // sync: no layout needed, must not pause in a background tab
  markSyncMapDirty();                                    // block positions changed — anchor table rebuilds on next sync
  requestAnimationFrame(() => { updateScrollCues(); updatePageBreaks(); });   // these need layout (offsetWidth/scrollHeight)
}

/* ---------- selection mirroring (block-level spike) ----------
   Tag each rendered top-level content block with the source line range it came
   from (order-zip against blockmap.sourceBlocks — see blockmap.js for why it's
   approximate), then highlight the matching block in the preview as the caret /
   selection moves in the editor, and vice-versa. Generated sections (title
   block, references, footnotes, TOC) are excluded from the zip so they don't
   shift the alignment. */
/* Appended-only elements with no corresponding SOURCE block. nav.toc is NOT
   here: it replaces the [TOC] paragraph in flow, so it pairs with that source
   line (selecting the rendered contents list mirrors to "[TOC]"). */
const GENERATED = '.doc-header, .references, .footnotes, .bib-chip, .page-sep, .page-no';
function previewContentBlocks() {
  return [...preview.children].filter((el) => !el.matches(GENERATED));
}
function tagPreviewBlocks() {
  const els = previewContentBlocks();
  for (const el of els) { delete el.dataset.srcStart; delete el.dataset.srcEnd; }
  if (texPreviewOn) return;   // LaTeX source lines ≠ converted preview blocks — no mirror
  const blocks = sourceBlocks(editor.value);
  const n = Math.min(blocks.length, els.length);
  for (let k = 0; k < n; k++) { els[k].dataset.srcStart = blocks[k].start; els[k].dataset.srcEnd = blocks[k].end; }
}
function offsetOfLine(src, line) {
  if (line <= 0) return 0;
  let seen = 0;
  for (let k = 0; k < src.length; k++) { if (src.charCodeAt(k) === 10 && ++seen === line) return k + 1; }
  return src.length;
}
let mirrorRAF = null;
function clearMirror() { for (const el of preview.querySelectorAll('.src-linked')) el.classList.remove('src-linked'); }

/* editor caret/selection → highlight the matching preview block(s) (native DOM
   highlight; scrolls with the content) */
function highlightFromEditor() {
  clearEditorHighlight(); lastMirror = null;
  const l0 = lineOfOffset(editor.value, editor.selectionStart);
  const l1 = lineOfOffset(editor.value, editor.selectionEnd);
  for (const el of preview.querySelectorAll('[data-src-start]')) {
    el.classList.toggle('src-linked', +el.dataset.srcStart <= l1 && +el.dataset.srcEnd >= l0);
  }
}

/* ---- editor-side highlight (preview→editor direction) ----
   The highlight is painted as a linear-gradient BACKGROUND on the textarea with
   `background-attachment: local`, so the browser scrolls the band WITH the text
   content — truly 0-latency (compositor-painted), custom-colored, and needs no
   overlay element or scroll handler. A hidden mirror div gives wrap-accurate
   pixel Ys for the band edges (measured once per selection). */
let editorMirror = null, lastMirror = null;
function ensureEditorMirror() {
  if (!editorMirror) {
    editorMirror = document.createElement('div'); editorMirror.setAttribute('aria-hidden', 'true');
    editorMirror.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;top:0;left:-9999px;white-space:pre-wrap;overflow-wrap:break-word;box-sizing:border-box;';
    document.body.appendChild(editorMirror);
  }
  const cs = getComputedStyle(editor), m = editorMirror;
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingLeft', 'paddingRight', 'paddingTop', 'tabSize', 'wordBreak']) m.style[p] = cs[p];
  m.style.width = editor.clientWidth + 'px';
  return m;
}
function measureOffsetTop(offset) {
  const m = ensureEditorMirror();
  m.textContent = editor.value.slice(0, offset);
  const mark = document.createElement('span'); mark.textContent = '​'; m.appendChild(mark);
  const top = mark.offsetTop; m.textContent = '';
  return top;
}
/* Batch variant for the scroll-sync anchor table: ONE mirror build + one
   layout pass measures every line at once (per-line measureOffsetTop calls
   would be O(blocks × doc length)). `lines` must be ascending (block order).
   Markers are zero-width spans at line STARTS (right after a newline), so
   they cannot change where anything wraps. */
function measureEditorLineTops(lines) {
  if (cm) return lines.map((l) => cm.lineTop(l));
  const m = ensureEditorMirror();
  const src = editor.value;
  const frag = document.createDocumentFragment();
  const marks = [];
  let prev = 0;
  for (const line of lines) {
    const off = offsetOfLine(src, line);
    frag.appendChild(document.createTextNode(src.slice(prev, off)));
    const mark = document.createElement('span'); mark.textContent = '​';
    frag.appendChild(mark); marks.push(mark);
    prev = off;
  }
  frag.appendChild(document.createTextNode(src.slice(prev)));
  m.replaceChildren(frag);
  const tops = marks.map((mk) => mk.offsetTop);
  m.textContent = '';
  return tops;
}
function setEditorHighlight(startLine, endLine) {
  if (cm) { cm.highlightLines(startLine, endLine); return; }   // CM: line decorations — cannot drift
  const yTop = measureOffsetTop(offsetOfLine(editor.value, startLine));
  const yBot = measureOffsetTop(offsetOfLine(editor.value, endLine + 1));
  editor.style.backgroundImage = 'linear-gradient(to bottom, transparent ' + yTop + 'px, var(--hl-band) ' + yTop + 'px, var(--hl-band) ' + yBot + 'px, transparent ' + yBot + 'px)';
  editor.style.backgroundRepeat = 'no-repeat';
  editor.style.backgroundAttachment = 'local';   // scroll the band with the text (0 latency)
}
function clearEditorHighlight() { if (cm) { cm.clearHighlight(); return; } editor.style.backgroundImage = ''; }
function revealEditorLine(line) {
  if (cm) { cm.scrollToLine(line); return; }
  const cs = getComputedStyle(editor);
  const lh = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) || 14) * 1.7;
  // mirror-measured, not line × lineHeight — wrapped lines make the estimate drift
  const target = measureOffsetTop(offsetOfLine(editor.value, line));
  if (target < editor.scrollTop || target > editor.scrollTop + editor.clientHeight - 2 * lh) {
    editor.scrollTop = Math.max(0, target - editor.clientHeight / 3);
  }
}
/* preview selection (one OR MANY blocks) → highlight every spanned block and
   mirror the whole span into the editor selection + the visible band.

   The mirror's programmatic editor scroll must NOT feed scroll sync: editor
   scroll → syncScroll → the PREVIEW scrolls under the user's still-held mouse
   → the browser extends the selection to everything that scrolled past → the
   mirror runs again — a runaway loop that "selects a ton of things". So the
   reveal is (a) deferred until the mouse is released and (b) wrapped in
   scrollLock. */
let previewSelecting = false, pendingReveal = null;
function withScrollLock(fn) {
  acquireScrollLock();   // generation-token + double-rAF release (see its definition)
  fn();
}
previewPane.addEventListener('pointerdown', () => { previewSelecting = true; });
window.addEventListener('pointerup', () => {
  if (!previewSelecting) return;
  previewSelecting = false;
  if (pendingReveal != null) { const l = pendingReveal; pendingReveal = null; withScrollLock(() => revealEditorLine(l)); }
});
function highlightFromPreview() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) { clearMirror(); clearEditorHighlight(); lastMirror = null; return; }
  const range = sel.getRangeAt(0);
  const blocks = [...preview.querySelectorAll('[data-src-start]')].filter((el) => range.intersectsNode(el));
  if (!blocks.length) { clearMirror(); clearEditorHighlight(); lastMirror = null; return; }
  let lo = Infinity, hi = -Infinity;
  for (const el of blocks) { lo = Math.min(lo, +el.dataset.srcStart); hi = Math.max(hi, +el.dataset.srcEnd); }
  if (lastMirror && lastMirror.lo === lo && lastMirror.hi === hi) return;   // unchanged — no-op re-entry
  lastMirror = { lo, hi };
  clearMirror();
  for (const el of blocks) el.classList.add('src-linked');
  const a = offsetOfLine(editor.value, lo);
  const b = Math.max(a, offsetOfLine(editor.value, hi + 1) - 1);
  editor.setSelectionRange(a, b);
  if (cm) cm.setSelection(a, b, { scroll: false });   // the reveal below handles scrolling
  setEditorHighlight(lo, hi);
  if (previewSelecting) pendingReveal = lo;            // mid-drag: never move panes under the mouse
  else withScrollLock(() => revealEditorLine(lo));
}
function onSelectionChange() {
  if (mirrorRAF) return;
  mirrorRAF = requestAnimationFrame(() => {
    mirrorRAF = null;
    if (state.view !== 'split') return;                 // mirroring needs both panes
    const sel = window.getSelection();
    // direction is decided by WHERE the live selection is, not which pane has focus
    const inPreview = sel && sel.rangeCount && !sel.isCollapsed
      && preview.contains(sel.anchorNode) && preview.contains(sel.focusNode);
    if (inPreview) highlightFromPreview();
    else if (document.activeElement === editor) highlightFromEditor();
  });
}

/* Page-break guides + page numbers, in BOTH reading layouts.
   PAGED: every sheet is a true fixed-height Letter page. When a block would
   cross a sheet's content area, a .page-sep filler is inserted before it that
   pads out the REST of the sheet with blank paper, then a recessed .page-gap
   groove between sheets, then the next sheet's top margin — so the preview
   reads as stacked physical pages. The page number lives INSIDE the filler
   (fixed distance above the sheet's bottom edge, right margin), so it tracks
   the real layout — inserting a filler un-collapses the neighbors' CSS
   margins, which made externally-predicted label positions drift.
   FLOW (continuous): no fillers; markers sit in the right margin at each
   Letter-page interval of content so you still see pagination.
   Live-preview only — exports paginate via real print/@page. */
function updatePageBreaks() {
  preview.querySelectorAll('.page-sep, .page-no').forEach((el) => el.remove());
  const w = preview.offsetWidth;
  if (w <= 200) return;                                   // flattened/mobile: skip
  const pageH = w * 11 / 8.5, margin = 96, gap = 30;
  const usable = pageH - 2 * margin;                      // one Letter page's worth of content
  if (usable < 160) return;
  const paperTop = preview.getBoundingClientRect().top;
  const blocks = [...preview.children]
    .filter((el) => !el.matches(GENERATED))
    .map((el) => { const r = el.getBoundingClientRect(); return { el, top: r.top - paperTop, bottom: r.bottom - paperTop }; });
  if (!blocks.length) return;
  const firstTop = blocks[0].top, contentBottom = blocks[blocks.length - 1].bottom;
  const makeNo = (p, y) => {
    const no = document.createElement('div');
    no.className = 'page-no'; no.setAttribute('aria-hidden', 'true');
    no.textContent = p; no.style.top = y + 'px';
    return no;
  };

  if (settings.readingLayout === 'paged') {
    let cumShift = 0, sheetTop = 0, page = 1, guard = 0;
    for (let i = 0; i < blocks.length; i++) {
      if (++guard > 4000) break;
      const b = blocks[i];
      const limit = sheetTop + pageH - margin;             // this sheet's content bottom
      const rTop = b.top + cumShift, rBot = b.bottom + cumShift;
      if (rBot > limit + 0.5 && rTop > sheetTop + 1) {
        let cand = b;   // don't orphan a heading at the page foot — break before it
        if (i > 0 && /^H[1-6]$/.test(blocks[i - 1].el.tagName) && blocks[i - 1].top + cumShift > sheetTop + 1) cand = blocks[i - 1];
        const cTop = cand.top + cumShift;
        const sheetBottom = sheetTop + pageH;
        const fill = Math.max(0, sheetBottom - cTop);      // blank rest of this sheet
        const h = fill + gap + margin;                     // + inter-sheet gap + next sheet's top margin
        const sep = document.createElement('div');
        sep.className = 'page-sep'; sep.setAttribute('aria-hidden', 'true'); sep.style.height = h + 'px';
        const gapEl = document.createElement('div');
        gapEl.className = 'page-gap'; gapEl.style.top = fill + 'px'; gapEl.style.height = gap + 'px';
        sep.append(gapEl, makeNo(page, Math.max(4, fill - 46)));
        cand.el.before(sep);                               // safe: block Ys were cached before any insert
        cumShift += h; sheetTop = sheetBottom + gap; page++;
      }
    }
    // Last sheet: measure LIVE (the fillers above are already in the layout),
    // then pad the paper so the last page is a full Letter sheet too.
    const seps = preview.querySelectorAll('.page-sep');
    const liveSheetTop = seps.length
      ? seps[seps.length - 1].getBoundingClientRect().bottom - paperTop - margin
      : 0;
    const kids = [...preview.children].filter((el) => !el.matches('.page-no'));
    const liveEnd = kids.length ? kids[kids.length - 1].getBoundingClientRect().bottom - paperTop : 0;
    const sheetBottom = liveSheetTop + pageH;
    const padBottom = margin + 24;                         // .paper's own bottom padding
    const tail = document.createElement('div');
    tail.className = 'page-sep last'; tail.setAttribute('aria-hidden', 'true');
    tail.style.height = Math.max(0, sheetBottom - liveEnd - padBottom) + 'px';
    tail.appendChild(makeNo(page, Math.max(4, sheetBottom - liveEnd - 46)));
    preview.appendChild(tail);
  } else {
    const pages = Math.max(1, Math.ceil((contentBottom - firstTop) / usable));   // flow: a marker per Letter interval
    for (let k = 1; k <= pages; k++) preview.appendChild(makeNo(k, Math.min(firstTop + k * usable, contentBottom) - 16));
  }
}

/* "More below" edge fades on the internal scroll panes — hidden overlay
   scrollbars give no hint that content continues (see docs/research). */
const editorPaneEl = document.querySelector('.editor-pane');
function cue(pane, scroller) {
  if (!pane || !scroller) return;
  pane.classList.toggle('can-scroll-more',
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 24);
}
function updateScrollCues() { cue(editorPaneEl, cm ? cm.scroller : editor); cue(previewPane, previewPane); }

/* Remote images are stripped by the sanitizer (privacy: opening a document must
   not phone home). Offer a per-document, per-session opt-in. */
let remoteOfferedFor = null;
function offerRemoteImages() {
  const blocked = preview.querySelectorAll('img[data-remote-src]').length;
  if (!blocked || getAllowRemoteImages() || remoteOfferedFor === state.currentName) return;
  remoteOfferedFor = state.currentName;
  const forDoc = state.currentName;   // the toast may outlive a doc switch — never opt in a DIFFERENT doc
  toast(blocked + ' remote image' + (blocked === 1 ? '' : 's') + ' blocked for privacy', {
    actionLabel: 'Load for this document',
    onAction: () => { if (state.currentName === forDoc) { setAllowRemoteImages(true); doRender(); } },
  });
}
function updateCounts(result) {
  const text = editor.value;
  const words = (text.match(/\S+/g) || []).length;
  const lines = text.length ? text.split('\n').length : 0;
  const mins = Math.max(1, Math.ceil(words / 200));
  const parts = [words + ' words', text.length + ' chars', lines + ' lines', '~' + mins + ' min read'];
  if (result && result.eqCount > 0) parts.push(result.eqCount + (result.eqCount === 1 ? ' eq' : ' eqs'));
  if (result && result.citeCount > 0) parts.push(result.citeCount + (result.citeCount === 1 ? ' cite' : ' cites'));
  countsEl.textContent = parts.join(' · ');
}
function setDirty(v) { state.dirty = v; statusDot.classList.toggle('warn', v); }

/* ---------- autosave + drafts ---------- */
const hhmm = () => { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
/* Drafts are namespaced per STORAGE SCOPE: a bare name in the in-app library
   (compatible with every pre-existing draft), `p:<projectId>:` inside a
   project. Without this, browser-Welcome.md's draft would silently override a
   project's Welcome.md file on open (folder files used to load with mtime 0,
   so any same-named draft from anywhere won). */
const draftKey = (name) =>
  (folderHandle && activeProjectIdx >= 0 && projects[activeProjectIdx] && projects[activeProjectIdx].id
    ? 'p:' + projects[activeProjectIdx].id + ':' : '') + name;
/* Version history gets the same per-scope namespacing: two projects each
   holding a "report.md" must not share (or cross-restore) one version bucket. */
const versionKey = draftKey;
let autosaveTimer = null;
function scheduleAutosave() { clearTimeout(autosaveTimer); saveInfo.textContent = 'editing…'; autosaveTimer = setTimeout(flushDraft, settings.autosaveMs); }
async function flushDraft() {
  clearTimeout(autosaveTimer);
  if (!state.currentName) return;
  try { await draftPut(draftKey(state.currentName), editor.value); saveInfo.textContent = 'saved locally ' + hhmm(); } catch { /* ignore */ }
}

/* ---------- document lifecycle ---------- */
function setEditorValue(v) { editor.value = v; if (cm) cm.setValue(v); }   // a load: intentionally resets the undo stack
function focusEditor() { if (cm) cm.focus(); else editor.focus(); }

/* Rapid switching guard: two overlapping loads race their IDB/file reads, and
   whichever resolves LAST used to win the editor regardless of which the user
   clicked most recently. Every await below re-checks the generation. */
let loadGen = 0;
async function loadDocByName(name) {
  const gen = ++loadGen;
  if (hasLoaded) await flushDraft();                    // keep the current draft under the OLD name
  if (gen !== loadGen) return;
  revokeAssetUrls();                                    // release this doc's blob URLs; they re-create on demand
  setAllowRemoteImages(false);                          // remote-image opt-in is per document
  let doc;
  if (folderHandle) {
    // real file mtime, so a stale draft can never outrank on-disk edits
    try { const f = await folderReadFile(name); doc = { content: await f.text(), mtime: f.lastModified || 0 }; }
    catch { toast('Could not open “' + name + '” — it may have been renamed or deleted outside Colophon (try Refresh)', { kind: 'error', timeout: 7000 }); return; }
  } else doc = await docGet(name);
  if (!doc || gen !== loadGen) return;
  let content = doc.content || '', restored = false;
  try { const draft = await draftGet(draftKey(name)); if (draft && draft.ts > (doc.mtime || 0) && draft.content !== content) { content = draft.content; restored = true; } } catch { /* ignore */ }
  if (gen !== loadGen) return;
  setEditorValue(content);
  state.currentName = name; fileLabel.textContent = name; hasLoaded = true;
  setDirty(restored);
  lsSet('colophon-last', name);
  rememberProjectDoc(name);                             // per-project "reopen where I left off"
  doRender();
  findbar.refresh();                                    // recount against the newly-loaded document
  editor.scrollTop = 0; previewPane.scrollTop = 0;
  saveInfo.textContent = restored ? 'unsaved draft restored' : 'saved locally ' + hhmm();
  await refreshLibrary();
  if (gen !== loadGen) return;                          // a newer load landed mid-refresh: its toasts, not ours
  // a raw .tex document (seeded Welcome.tex, or one from a linked folder):
  // the preview already renders it via the live conversion — offer an
  // EDITABLE Markdown copy; the .tex file itself is never modified
  if (/\.(tex|latex)$/i.test(name) && looksLikeLatex(content)) {
    toast('Previewing this .tex as a converted document. Want an editable Markdown copy?', {
      actionLabel: 'Create .md copy',
      onAction: () => { if (state.currentName === name) convertTexToMdCopy(); },
      timeout: 9000,
    });
  }
  if (restored) {
    toast('Restored unsaved changes', {
      actionLabel: 'Discard',
      // the toast outlives fast doc switches — never discard onto a DIFFERENT open doc
      onAction: async () => {
        if (state.currentName !== name) return;
        setEditorValue(doc.content || ''); setDirty(false);
        try { await draftClear(draftKey(name)); } catch { /* ignore */ }
        doRender();
      },
    });
  }
}

async function explicitSave() {
  const name = state.currentName;
  try {
    // one write per mode — mirroring folder saves into IDB used to pollute the
    // in-app library with copies of every project document
    if (folderHandle) await folderWrite(name, editor.value);
    else await docPut(name, editor.value);
    await versionAdd(versionKey(name), editor.value, 'save');
    await draftClear(draftKey(name));
    // success side-effects only after every write resolved — a failed folder
    // write must not show "Saved" with a cleared dirty flag
    setDirty(false);
    saveInfo.textContent = 'saved ' + hhmm();
    await refreshLibrary();
    // IDB can fail over to a volatile in-memory store MID-session (quota,
    // eviction) — a "Saved" that only lives in this tab must say so
    if (!folderHandle && storageMode() === 'memory') {
      toast('Saved only for this session — browser storage is unavailable. Export your work or link a folder.', { kind: 'error', timeout: 0 });
    } else toast('Saved');
  } catch (e) {
    saveInfo.textContent = 'save failed';
    toast('Save failed — ' + (e && e.name === 'NotAllowedError'
      ? 'folder permission was revoked (relink the folder)'
      : 'your work is still safe in the local draft'), { kind: 'error' });
  }
}

/* Name comparisons are normalization+case-folded: the on-disk filesystem
   treats "Report.md"/"report.md" and NFC/NFD "café" as the SAME file, so a
   byte-exact check calls a colliding name free — and the write overwrites. */
const normName = (s) => { try { return String(s).normalize('NFC').toLowerCase(); } catch { return String(s).toLowerCase(); } };
function nextName(base, ext) {
  const names = new Set(docsCache.map((d) => normName(d.name)));
  if (!names.has(normName(base + ext))) return base + ext;
  for (let i = 2; ; i++) if (!names.has(normName(base + '-' + i + ext))) return base + '-' + i + ext;
}
/* Silent creation (auto-named) — for flows where a prompt would be hostile:
   the clipboard command, the after-delete fallback, and boot. */
async function createUntitled() {
  await refreshLibrary();
  const name = nextName('untitled', '.md');
  try { await writeNewDoc(name, ''); } catch { toast('Could not create ' + name, { kind: 'error' }); return false; }
  await loadDocByName(name);
  focusEditor();
  return true;
}
/* Ask for the name FIRST (prefilled, basename selected) — creating untitled.md
   and then renaming it is backwards. A name with a slash (notes/x.md) creates
   the subfolder in folder mode. */
function promptDocName({ title, initial, cta }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); };
    const wrap = document.createElement('div');
    const label = document.createElement('label'); label.htmlFor = 'newNameInput'; label.textContent = 'Document name';
    const inp = document.createElement('input'); inp.type = 'text'; inp.id = 'newNameInput'; inp.value = initial;
    const err = document.createElement('div'); err.className = 's-d'; err.style.color = 'var(--accent)'; err.style.minHeight = '16px';
    async function submit() {
      let name = inp.value.trim();
      if (!name) { err.textContent = 'Name cannot be empty.'; return; }
      if (!/\.[a-z0-9]+$/i.test(name)) name += '.md';
      await refreshLibrary();   // the check must see files that appeared while the dialog sat open
      if (docsCache.some((d) => normName(d.name) === normName(name))) { err.textContent = 'A document with that name already exists.'; return; }
      closeDialog(); finish(name);
    }
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    wrap.append(label, inp, err, dialogActions([
      { label: 'Cancel', onClick: () => { closeDialog(); finish(null); } },
      { label: cta || 'Create', primary: true, onClick: submit },
    ]));
    openDialog({ title, body: wrap, onClose: () => finish(null), initialFocus: '#newNameInput' });
    setTimeout(() => { inp.focus(); inp.setSelectionRange(0, initial.replace(/\.[^.]+$/, '').length); }, 0);
  });
}
async function newDoc() {
  await refreshLibrary();
  const name = await promptDocName({ title: 'New document', initial: nextName('untitled', '.md') });
  if (!name) return false;
  try { await writeNewDoc(name, ''); } catch { toast('Could not create ' + name, { kind: 'error' }); return false; }
  await loadDocByName(name);
  focusEditor();
  return true;
}
function newFromTemplate() {
  const grid = document.createElement('div');
  grid.className = 'tpl-grid';
  for (const t of TEMPLATES) {
    const card = document.createElement('button');
    card.type = 'button'; card.className = 'tpl-card';
    const tt = document.createElement('div'); tt.className = 't'; tt.textContent = t.name;
    const dd = document.createElement('div'); dd.className = 'd'; dd.textContent = t.desc;
    card.append(tt, dd);
    card.addEventListener('click', async () => { closeDialog(); await createFromTemplate(t); });
    grid.appendChild(card);
  }
  openDialog({ title: 'New from template', body: grid });
}
async function createFromTemplate(t) {
  await refreshLibrary();
  const name = await promptDocName({ title: 'New from template — ' + t.name, initial: nextName(t.id, '.md') });
  if (!name) return;
  try { await writeNewDoc(name, t.content); } catch { toast('Could not create ' + name, { kind: 'error' }); return; }
  await loadDocByName(name);
  focusEditor();
}
/* The wedge, as one gesture: clipboard → new document → repair. Copy an AI
   answer, run this, get a clean document — no paste, no second step. The
   command is the explicit request, so the fix runs without a hand-off offer
   (unlike a plain paste, which only OFFERS); both paths snapshot first and
   stay undoable. */
async function newFromClipboard() {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch { /* denied/unsupported */ }
  if (!text || !text.trim()) {
    const paste = IS_MAC ? '⌘V' : 'Ctrl+V';
    toast('Could not read text from the clipboard — paste into the editor instead (' + paste + ')', { kind: 'error' });
    return;
  }
  // CRITICAL: only write the clipboard into the editor once the NEW doc exists.
  // If newDoc() failed (e.g. folder write denied), continuing would overwrite
  // the currently-open document — with the undo stack reset and autosave armed.
  if (!(await createUntitled())) return;
  setEditorValue(text);
  setDirty(true); scheduleRender(); scheduleAutosave();
  if (looksLikeLatex(text)) await runLatexImport();
  focusEditor();
}
function rename() { renameDoc(state.currentName); }
/* folder-mode rename: write-new-then-remove-old, in that order — a failure
   mid-way leaves BOTH files rather than losing the document */
async function folderRename(oldName, newName) {
  const text = await folderRead(oldName);
  if (!(await ensureFolderWrite())) throw new Error('folder write permission denied');
  await folderWrite(newName, text);
  await folderRemove(oldName);
  try {   // carry the project-scoped draft across the rename
    const dr = await draftGet(draftKey(oldName));
    if (dr && dr.content != null) await draftPut(draftKey(newName), dr.content);
    await draftClear(draftKey(oldName));
  } catch { /* ignore */ }
  try {   // and the version history (browser-mode docRename already does this)
    const vs = await versionsList(versionKey(oldName));
    for (const v of vs) await versionAdd(versionKey(newName), v.content, v.reason, v.ts);
    await versionsClear(versionKey(oldName));
  } catch { /* ignore */ }
}
function renameDoc(oldName) {
  const wrap = document.createElement('div');
  const label = document.createElement('label'); label.htmlFor = 'renameInput'; label.textContent = 'Document name';
  const inp = document.createElement('input'); inp.type = 'text'; inp.id = 'renameInput'; inp.value = oldName;
  const err = document.createElement('div'); err.className = 's-d'; err.style.color = 'var(--accent)'; err.style.minHeight = '16px';
  async function submit() {
    let name = inp.value.trim();
    if (!name) { err.textContent = 'Name cannot be empty.'; return; }
    if (!/\.[a-z0-9]+$/i.test(name)) name += '.md';
    if (name === oldName) { closeDialog(); return; }
    await refreshLibrary();
    // normalization+case-folded: the fs treats Report.md/report.md (and
    // NFC/NFD café) as ONE file — a byte-exact check would approve a rename
    // whose write lands on, then deletes, the very same file
    if (docsCache.some((d) => normName(d.name) === normName(name))) { err.textContent = 'A document with that name already exists (names that differ only by case count).'; return; }
    closeDialog();
    try {
      if (folderHandle) await folderRename(oldName, name);
      else await docRename(oldName, name);
    } catch (e) {
      toast('Rename failed — ' + ((e && e.message) || e), { kind: 'error' });
      await refreshLibrary();
      return;
    }
    if (state.currentName === oldName) { state.currentName = name; fileLabel.textContent = name; lsSet('colophon-last', name); }
    await refreshLibrary();
    toast('Renamed to ' + name);
  }
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  wrap.append(label, inp, err, dialogActions([
    { label: 'Cancel', onClick: () => closeDialog() },
    { label: 'Rename', primary: true, onClick: submit },
  ]));
  openDialog({ title: 'Rename document', body: wrap, initialFocus: '#renameInput' });
  setTimeout(() => {
    inp.focus();
    // select only the LEAF name — pre-selecting "notes/report" makes a plain
    // rename silently MOVE the doc out of its subfolder
    inp.setSelectionRange(oldName.lastIndexOf('/') + 1, oldName.replace(/\.[^.]+$/, '').length);
  }, 0);
}
async function duplicate() {
  await refreshLibrary();
  const ext = (state.currentName.match(/\.[^.]+$/) || ['.md'])[0];
  const base = state.currentName.slice(0, state.currentName.length - ext.length) + '-copy';
  const name = nextName(base, ext);
  try { await writeNewDoc(name, editor.value); } catch { toast('Could not duplicate', { kind: 'error' }); return; }
  await loadDocByName(name);
  toast('Duplicated as ' + name);
}
/* Storage-agnostic doc IO — the library is either IndexedDB docs or a linked
   folder on disk; every file operation below works in both modes. */
async function readDocContent(name) {
  if (name === state.currentName) return editor.value;   // the open doc: what you see (incl. unsaved edits)
  if (folderHandle) return folderRead(name);
  const d = await docGet(name);
  return d ? d.content : '';
}
async function writeNewDoc(name, content) {
  if (folderHandle) {
    if (!(await ensureFolderWrite())) throw new Error('folder write permission denied');
    await folderWrite(name, content);
  } else await docPut(name, content);
}
async function ensureFolderWrite() {
  if (!folderHandle) return true;
  try {
    if ((await folderHandle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
    return (await folderHandle.requestPermission({ mode: 'readwrite' })) === 'granted';
  } catch { return false; }
}

/* ⌘C/⌘V on library items: an internal file clipboard. Copy also puts the raw
   markdown on the system clipboard (paste into other apps as text); Paste
   materialises a copy in the library — and, in folder mode, on disk. */
let libClipboard = null;   // {name, content}
async function copyDoc(name) {
  try {
    const content = await readDocContent(name);
    libClipboard = { name, content };
    copyText(content);
    toast('Copied ' + name);
  } catch { toast('Could not read the document', { kind: 'error' }); }
}
async function pasteDoc() {
  if (!libClipboard) { toast('Nothing to paste — copy a library document first (⌘C)'); return; }
  await refreshLibrary();
  const ext = (libClipboard.name.match(/\.[^.]+$/) || ['.md'])[0];
  const name = nextName(libClipboard.name.slice(0, libClipboard.name.length - ext.length) + '-copy', ext);
  try { await writeNewDoc(name, libClipboard.content); } catch { toast('Paste failed — could not write ' + name, { kind: 'error' }); return; }
  await refreshLibrary();
  toast('Pasted as ' + name + (folderHandle ? ' (in “' + folderHandle.name + '”)' : ''));
}
async function duplicateDoc(name) {   // duplicate a SPECIFIC library doc (context menu / ⌘D)
  let content = '';
  try { content = await readDocContent(name); } catch { toast('Could not read the document', { kind: 'error' }); return; }
  const ext = (name.match(/\.[^.]+$/) || ['.md'])[0];
  const newName = nextName(name.slice(0, name.length - ext.length) + '-copy', ext);
  try { await writeNewDoc(newName, content); } catch { toast('Could not duplicate', { kind: 'error' }); return; }
  await refreshLibrary();
  toast('Duplicated as ' + newName);
}
/* The honest bridge between the in-app library (IndexedDB — persistent, but no
   path on disk) and real files. In folder mode documents ARE files, so these
   only appear for the browser library. */
async function saveDocToDisk(name) {
  let content;
  try { content = await readDocContent(name); }
  catch { toast('Could not read “' + name + '”', { kind: 'error' }); return; }
  const mime = /\.(md|markdown|mdown)$/i.test(name) ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8';
  download(name, content, mime);
  toast('“' + name + '” downloaded — check your Downloads folder');
}
async function saveAllToDisk() {
  const docs = folderHandle ? [] : await docsAll();
  if (!docs.length) { toast('The in-app library is empty — nothing to save'); return; }
  if (state.dirty) { try { await explicitSave(); } catch { /* fall back to stored copies */ } }
  toast('Saving ' + docs.length + ' document' + (docs.length === 1 ? '' : 's') + ' to your Downloads folder — if the browser asks to allow multiple downloads, allow it', { timeout: 9000 });
  for (const d of await docsAll()) {   // re-read so the just-saved open doc is fresh
    const mime = /\.(md|markdown|mdown)$/i.test(d.name) ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8';
    download(d.name, d.content || '', mime);
    await new Promise((r) => setTimeout(r, 300));   // stagger so the browser accepts the burst
  }
  toast('Done — ' + docs.length + ' file' + (docs.length === 1 ? '' : 's') + ' sent to your Downloads folder');
}
function whereIsDoc(name) {
  const wrap = document.createElement('div');
  const p1 = document.createElement('p');
  p1.style.marginTop = '0';
  p1.textContent = '“' + name + '” is not a file on disk. It lives in this browser’s private storage for '
    + (location.protocol === 'file:' ? 'the file:// copy of Colophon' : location.host)
    + ' — saved and persistent, but invisible in Finder.';
  const p2 = document.createElement('p');
  p2.textContent = 'Save to disk puts a real copy in Downloads. '
    + (folderSupported()
      ? 'Or link a project folder (＋ Add folder…) — then every document and figure lives as a real file automatically.'
      : 'For documents that live as real files automatically, launch Colophon by double-clicking Colophon.command (next to this app) — that enables project folders — then link a folder.');
  wrap.append(p1, p2, dialogActions([
    { label: 'Close', onClick: () => closeDialog() },
    { label: 'Save to disk', primary: true, onClick: () => { closeDialog(); saveDocToDisk(name); } },
  ]));
  openDialog({ title: 'Where is this file?', body: wrap });
}
async function openFolderDocInTab(name) {
  try {
    const f = await folderReadFile(name);
    const url = URL.createObjectURL(f);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch { toast('Could not open “' + name + '”', { kind: 'error' }); }
}
/* In-app viewer for figures and PDFs — assets get a read surface inside
   Colophon (like Read view for documents) instead of a raw browser tab.
   `source` is a File/Blob (or a promise of one) or {url} for something
   already resolvable. NOTE: a web page cannot hand a file to the OS-default
   app — the folder API never reveals absolute paths, by design — so "open in
   Preview.app" is desktop-shell territory; the escape hatch is the browser's
   own full-tab viewer. */
async function openAssetViewer(path, source, opts = {}) {
  let url, revoke = false, size = null;
  try {
    const s = await source;
    if (s && s.url) { url = s.url; }
    else { url = URL.createObjectURL(s); revoke = true; size = s.size; }
  } catch { toast('Could not read “' + path + '”', { kind: 'error' }); return; }
  const isPdf = opts.kind === 'pdf' || /\.pdf$/i.test(path);
  const wrap = document.createElement('div'); wrap.className = 'asset-view';
  const meta = document.createElement('div'); meta.className = 'asset-meta';
  meta.textContent = path + (size != null ? ' · ' + (size > 1024 * 1024 ? mb(size) : Math.max(1, Math.round(size / 1024)) + ' KB') : '');
  if (isPdf) {
    const fr = document.createElement('iframe');
    fr.className = 'asset-frame'; fr.src = url; fr.title = path;
    wrap.append(fr, meta);
  } else {
    const box = document.createElement('div'); box.className = 'asset-img-box';
    const img = document.createElement('img');
    img.className = 'asset-img'; img.src = url; img.alt = path;
    img.addEventListener('load', () => { if (img.naturalWidth) meta.textContent += ' · ' + img.naturalWidth + '×' + img.naturalHeight + ' px'; }, { once: true });
    box.appendChild(img);
    wrap.append(box, meta);
  }
  const actions = [];
  let openedInTab = false;   // a tab still pointing at the blob must keep it alive
  if (opts.insertable) actions.push({ label: 'Insert into document', onClick: () => { closeDialog(); insertAssetRef(path); } });
  if (opts.copyPath && folderHandle) actions.push({ label: 'Copy path', onClick: () => { copyText(folderHandle.name + '/' + path); toast('Copied ' + folderHandle.name + '/' + path); } });
  actions.push({ label: 'Open in new tab', onClick: () => { openedInTab = true; window.open(url, '_blank'); } });
  actions.push({ label: 'Close', primary: true, onClick: () => closeDialog() });
  wrap.appendChild(dialogActions(actions));
  openDialog({
    title: path.split('/').pop(),
    body: wrap,
    onClose: () => { if (revoke && !openedInTab) setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }, 60000); },
  });
}
function openFolderAsset(path) {
  openAssetViewer(path, folderReadFile(path), { insertable: true, copyPath: true });
}
/* Custom right-click menu for library docs (replaces Chrome's default) + shows
   the full filename in its header. */
let ctxMenuCleanup = null;
function closeContextMenu() {
  if (ctxMenuCleanup) { ctxMenuCleanup(); ctxMenuCleanup = null; }
  const m = q('ctxMenu');
  if (!m) return;
  m.removeAttribute('id');   // orphan it now so a new menu can open while this one fades
  m.classList.add('closing');
  const done = () => m.remove();
  m.addEventListener('transitionend', done, { once: true });
  setTimeout(done, 150);     // safety net ≥ the 80ms exit transition
}
function showContextMenu(x, y, header, items) {
  if (isDialogOpen()) return;   // no context menus over a modal — narrow layouts leave the sidebar clickable under the backdrop
  closeContextMenu();
  const menu = document.createElement('div'); menu.className = 'ctx-menu'; menu.id = 'ctxMenu';
  if (header) { const h = document.createElement('div'); h.className = 'ctx-head'; h.textContent = header; menu.appendChild(h); }
  for (const it of items) {
    if (it.sep) { const s = document.createElement('div'); s.className = 'ctx-sep'; menu.appendChild(s); continue; }
    const b = document.createElement('button'); b.type = 'button'; b.className = 'ctx-item' + (it.danger ? ' danger' : '');
    const lb = document.createElement('span'); lb.textContent = it.label; b.appendChild(lb);
    if (it.key) { const k = document.createElement('span'); k.className = 'ctx-key'; k.textContent = it.key; b.appendChild(k); }
    if (it.disabled) b.disabled = true;
    else b.addEventListener('click', () => { closeContextMenu(); it.run(); });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  menu.style.left = Math.min(x, window.innerWidth - menu.offsetWidth - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - menu.offsetHeight - 8) + 'px';
  // Close on press OUTSIDE the menu only — pointerdown fires BEFORE click, so a
  // press-anywhere closer would remove the item before its click could land.
  const onDown = (e) => { if (!menu.contains(e.target)) closeContextMenu(); };
  const onKey = (e) => { if (e.key === 'Escape') closeContextMenu(); };
  setTimeout(() => {   // skip the opening right-click's own event stream
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', closeContextMenu, { once: true });
  }, 0);
  ctxMenuCleanup = () => {
    document.removeEventListener('pointerdown', onDown);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('blur', closeContextMenu);
  };
}
function deleteDoc(name) {
  const target = name || state.currentName;
  if (settings.confirmDelete === false) { doDelete(target); return; }   // user opted out of the dialog
  const wrap = document.createElement('div');
  const p = document.createElement('p');
  const strong = document.createElement('strong'); strong.textContent = target;
  p.append(document.createTextNode('Delete '), strong, document.createTextNode(folderHandle
    ? '? The file moves to a “Colophon Trash” folder inside your linked folder (the browser can’t reach the macOS Trash). You can undo right after.'
    : '? You can undo right after.'));
  const lbl = document.createElement('label');
  lbl.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:12px;font-size:12.5px;color:var(--muted);cursor:pointer;';
  const cb = document.createElement('input'); cb.type = 'checkbox';
  lbl.append(cb, document.createTextNode("Don't ask again (you can re-enable this in Settings)"));
  wrap.append(p, lbl, dialogActions([
    { label: 'Cancel', onClick: () => closeDialog() },
    { label: 'Delete', primary: true, onClick: async () => {
      if (cb.checked) { settings.confirmDelete = false; persistSettings(); }
      closeDialog(); await doDelete(target);
    } },
  ]));
  openDialog({ title: 'Delete document', body: wrap });
}
async function doDelete(name) {
  let snapshot = null;
  try {
    snapshot = await readDocContent(name);
    if (snapshot != null) await versionAdd(versionKey(name), snapshot, 'pre-delete');
  } catch { /* ignore */ }
  if (folderHandle) {
    try {
      if (!(await ensureFolderWrite())) throw new Error('folder write permission denied');
      // The web sandbox cannot reach the real system Trash, so the closest
      // honest equivalent: move the file into a "Colophon Trash" subfolder of
      // the linked folder (visible in Finder, restorable by dragging back).
      const text = await folderRead(name);
      const trash = await folderHandle.getDirectoryHandle('Colophon Trash', { create: true });
      let trashName = name.split('/').pop();   // the trash is flat — a nested doc keeps its basename
      try { await trash.getFileHandle(trashName); trashName = trashName.replace(/(\.[^.]+)?$/, '-' + Date.now() + '$1'); } catch { /* free */ }
      const fh = await trash.getFileHandle(trashName, { create: true });
      const w = await fh.createWritable(); await w.write(text); await w.close();
      await folderRemove(name);
      try { await draftClear(draftKey(name)); } catch { /* ignore */ }   // else a later same-name file resurrects it
    } catch (e) { toast('Delete failed — ' + ((e && e.message) || e), { kind: 'error' }); return; }
  } else try {
    await docDelete(name);
    await draftClear(draftKey(name));
    await assetsGCSafe();                                // reclaim images no document references
  } catch { /* ignore */ }
  await refreshLibrary();
  if (state.currentName === name) {
    // cancel any pending autosave and detach the name BEFORE reloading,
    // otherwise loadDocByName's flushDraft resurrects draft:<deleted-name>
    clearTimeout(autosaveTimer);
    state.currentName = null;
    if (docsCache.length) await loadDocByName(docsCache[0].name);
    else await createUntitled();
  }
  toast('Deleted ' + name, snapshot == null ? {} : {
    actionLabel: 'Undo',
    onAction: async () => {
      try { await writeNewDoc(name, snapshot); } catch { toast('Could not restore ' + name, { kind: 'error' }); return; }
      await refreshLibrary();
      toast('Restored ' + name);
    },
    timeout: 8000,
  });
}

/* ---------- library ---------- */
function renderLib() {
  const hadFocus = libListEl.contains(document.activeElement);
  // remember WHICH row had focus — restoring to li.active would silently
  // retarget a keyboard user's next ⌘⌫/⌘D at the wrong document
  const focusedName = hadFocus && document.activeElement.closest
    ? (document.activeElement.closest('li[data-name]') || { dataset: {} }).dataset.name : null;
  renderLibrary(libListEl, docsCache, {
    currentName: state.currentName, folderMode: !!folderHandle, filter: libSearch.value,
    assets: folderHandle ? folderAssetsCache : [],
    collapsedDirs,
    onToggleDir: (dir) => { if (collapsedDirs.has(dir)) collapsedDirs.delete(dir); else collapsedDirs.add(dir); renderLib(); },
    onAsset: (n) => openFolderAsset(n),
    onOpen: (n) => loadDocByName(n),
    onDelete: (n) => deleteDoc(n),
    onRename: (n) => renameDoc(n),
  });
  if (hadFocus) {   // re-render replaces the nodes; don't strand keyboard users
    const el = (focusedName && libListEl.querySelector('li[data-name="' + cssEscape(focusedName) + '"]'))
      || libListEl.querySelector('li.active') || libListEl.querySelector('li[data-name]');
    if (el) el.focus();
  }
  libInfo.textContent = folderHandle
    ? ('folder · ' + docsCache.length + ' doc' + (docsCache.length === 1 ? '' : 's')
       + (folderAssetsCache.length ? ' · ' + folderAssetsCache.length + ' file' + (folderAssetsCache.length === 1 ? '' : 's') : ''))
    : (docsCache.length + (docsCache.length === 1 ? ' doc' : ' docs'));
}
async function refreshLibrary() {
  docsCache = folderHandle
    ? await folderList()
    : (await docsAll()).slice().sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  if (!folderHandle) browserDocsExist = docsCache.length > 0;   // keeps the demoted fallback entry honest
  renderLib();
}

/* ---------- outline navigation ---------- */
const cssEscape = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&');
function scrollToHeading(id) {
  if (state.view === 'editor') setView('split');
  const el = preview.querySelector('#' + cssEscape(id));
  if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
}
function updateCurrentHeading() {
  if (!lastOutline.length) return;
  const top = previewPane.getBoundingClientRect().top;
  let currentId = null;
  for (const h of lastOutline) {
    const el = preview.querySelector('#' + cssEscape(h.id));
    if (!el) continue;
    if (el.getBoundingClientRect().top - top <= 8) currentId = h.id;
    else break;
  }
  if (currentId) highlightOutline(outlineListEl, currentId);
}

/* ---------- LaTeX import flow (paste offer · palette command · .tex files) ----------
   Never automatic, snapshot first, undo-preserving, reports what happened.
   convertLatex() emits Markdown text only, so everything still flows through
   the one sanitize() gate at render. */
function latexSummary(r) {
  const top = (r.notes || []).slice(0, 3).map((n) => n.count + ' ' + n.what).join(', ');
  return (top || 'converted') + (r.confidence !== 'high' ? ' · confidence: ' + r.confidence : '');
}
function convertLatexText(text) {
  const conv = convertLatex(text);
  return { text: conv.text, notes: conv.notes, confidence: conv.confidence };
}
async function doLatexImport(start, end) {
  const name = state.currentName, before = editor.value;
  try { await versionAdd(versionKey(name), before, 'pre-latex-import'); } catch { /* ignore */ }
  let r;
  try { r = convertLatexText(editor.value.slice(start, end)); }
  catch { toast('LaTeX conversion failed', { kind: 'error' }); return; }
  applyEdit(editor, start, end, r.text);                // undo-preserving replacement
  setDirty(true); scheduleRender(); scheduleAutosave();
  toast('Converted from LaTeX: ' + latexSummary(r), {
    actionLabel: 'Undo',
    onAction: () => { editor.focus(); try { document.execCommand('undo'); } catch { /* ignore */ } scheduleRender(); },
  });
}
async function runLatexImport(region) {
  const start = region ? region.start : 0;
  const end = region ? region.end : editor.value.length;
  // The converter is LaTeX→Markdown; run on genuine Markdown it would rewrite
  // front matter (---), code fences (```), and dashes. The paste offer already
  // gates on looksLikeLatex, so a region is trusted; a whole-doc palette
  // invocation is not — refuse-with-override rather than silently mangle.
  if (!region && !looksLikeLatex(editor.value.slice(start, end))) {
    toast('This doesn’t look like LaTeX — converting could alter Markdown (front matter, code fences, dashes)', {
      kind: 'error', timeout: 8000,
      actionLabel: 'Convert anyway',
      onAction: () => doLatexImport(start, end),
    });
    return;
  }
  return doLatexImport(start, end);
}
/* A .tex document converts into a SIBLING .md copy — never rewritten in place
   (Markdown text living under a .tex name confuses every later open, and in
   folder mode it would silently corrupt a real LaTeX file on disk). */
async function convertTexToMdCopy() {
  const texName = state.currentName;
  let r;
  try { r = convertLatexText(editor.value); }
  catch { toast('LaTeX conversion failed', { kind: 'error' }); return; }
  await refreshLibrary();
  const name = nextName(texName.replace(/\.(tex|latex)$/i, ''), '.md');
  try { await writeNewDoc(name, r.text); } catch { toast('Could not create ' + name, { kind: 'error' }); return; }
  await loadDocByName(name);
  toast('Created ' + name + ' (' + latexSummary(r) + ') — ' + texName + ' is untouched');
}

/* Paste detection: if a large paste looks like LaTeX, OFFER conversion of just
   the pasted region — after the paste lands, never blocking it (the flow rule
   every exemplar follows: insert first, refine second). */
function offerLatexPaste(e) {
  let text = '';
  try { text = (e.clipboardData || window.clipboardData).getData('text/plain') || ''; } catch { return; }
  if (text.length < 200 || !looksLikeLatex(text)) return;
  const start = editor.selectionStart;
  const len = text.replace(/\r\n?/g, '\n').length;       // textarea normalizes CRLF on insert
  setTimeout(() => {
    toast('That paste looks like LaTeX', {
      actionLabel: 'Convert to Markdown',
      onAction: () => runLatexImport({ start, end: Math.min(start + len, editor.value.length) }),
      timeout: 8000,
    });
  }, 50);
}

/* ---------- Insert Figure (deliberate insertion; paste/drag stay frictionless) ----------
   Surfaces the caption/label/cross-ref machinery the renderer already has but
   the UI never revealed. Emits the pipeline-supported shape:
     ![caption](src) {#fig:label}
   with an optional pandoc/Quarto-style width attribute. The image itself reuses
   the existing asset pipeline (pick a file → colophon-asset: ref) or an
   already-inserted/remote URL the user pastes into the Source field. */
function slugifyLabel(s) {
  const base = String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return base || 'figure';
}
function fieldRow(labelText, control, hint) {
  const row = document.createElement('div'); row.className = 'field-row';
  const l = document.createElement('label'); l.className = 'field-l'; l.textContent = labelText;
  if (control.id) l.htmlFor = control.id;
  row.append(l, control);
  if (hint) { const h = document.createElement('div'); h.className = 'field-h'; h.textContent = hint; row.appendChild(h); }
  return row;
}
/* Jump the editor to a source line with the same reveal+flash the ⌥-click
   mapping uses — anything the app inserts or targets must be SEEN. */
function editorJumpToLine(startLine, endLine) {
  const off = offsetOfLine(editor.value, startLine);
  try { editor.setSelectionRange(off, off); } catch { /* ignore */ }
  if (cm) cm.setSelection(off, off, { scroll: false });
  setEditorHighlight(startLine, endLine == null ? startLine : endLine);
  withScrollLock(() => revealEditorLine(startLine));
  focusEditor();
}
/* Insert a block of markdown on its own paragraph — shared by the figure
   dialog and the library tree's "Insert into document". The result must be
   VISIBLE: Read view switches to Split, the editor scrolls to the insertion
   and flashes it (user report: a figure inserted into a hidden/unscrolled
   editor "vanished" and couldn't be deleted). */
function insertBlockMd(md, msg) {
  if (isTexDoc()) {   // the editor holds raw LaTeX — spliced Markdown would silently corrupt the source
    toast('This is a LaTeX document — Markdown can’t be inserted here. Add an \\includegraphics in the source instead.', { kind: 'error', timeout: 8000 });
    return;
  }
  if (state.view === 'preview') setView('split');
  let s = editor.selectionStart ?? editor.value.length, e = editor.selectionEnd ?? s;
  // an untouched caret at 0 means "no position chosen" — append at the end
  if (s === 0 && e === 0 && editor.value.length) { s = e = editor.value.length; }
  const before = editor.value.slice(0, s);
  const lead = (before === '' || before.endsWith('\n\n')) ? '' : (before.endsWith('\n') ? '\n' : '\n\n');
  applyEdit(editor, s, e, lead + md + '\n');
  setDirty(true); scheduleRender(); scheduleAutosave();
  const line = lineOfOffset(editor.value, s + lead.length);
  editorJumpToLine(line, line + md.split('\n').length - 1);
  if (msg) toast(msg);
}
/* Markdown-safe project path: parens escaped, spaces %-encoded — a raw space
   in a link/image destination breaks CommonMark parsing entirely (user's
   "Curtin Screw.pdf" rendered as literal text). Resolution decodes:
   folderFileAt and the data-local-href click handler. */
const mdPath = (p) => p.replace(/([()])/g, '\\$1').replace(/[ #?]/g, (c) => c === ' ' ? '%20' : encodeURIComponent(c));
function insertAssetRef(path) {
  if (/\.pdf$/i.test(path)) {
    const label = path.split('/').pop().replace(/([[\]])/g, '\\$1');
    insertBlockMd('[' + label + '](' + mdPath(path) + ')', 'Link inserted — click it in the preview to open the PDF');
    return;
  }
  insertBlockMd('![](' + mdPath(path) + ')', 'Figure inserted — add a caption between the brackets');
}
/* Remove a whole source block (a figure's lines) by its data-src range. */
function removeSourceBlock(startLine, endLine) {
  const lineCount = editor.value.split('\n').length;
  const s = offsetOfLine(editor.value, startLine);
  const e2 = endLine + 1 >= lineCount ? editor.value.length : offsetOfLine(editor.value, endLine + 1);
  applyEdit(editor, s, e2, '');
  setDirty(true); scheduleRender(); scheduleAutosave();
  toast('Removed — ⌘Z in the editor to undo');
}
async function openInsertFigure() {
  let pickedAsset = null;   // {id, name} once a file is chosen
  const wrap = document.createElement('div'); wrap.className = 'figure-form';

  const srcInput = document.createElement('input');
  srcInput.type = 'text'; srcInput.id = 'figSrc'; srcInput.className = 'field-in';
  srcInput.placeholder = folderHandle ? 'a file in your project, a URL — or choose →' : 'colophon-asset:… , a URL, or choose a file →';
  const pickBtn = document.createElement('button');
  pickBtn.type = 'button'; pickBtn.className = 'btn small'; pickBtn.textContent = 'Choose image…';
  const srcRow = document.createElement('div'); srcRow.className = 'field-in-group';
  srcRow.append(srcInput, pickBtn);

  const capInput = document.createElement('input');
  capInput.type = 'text'; capInput.id = 'figCap'; capInput.className = 'field-in';
  capInput.placeholder = 'e.g. Kink-pair energy vs. resolved shear stress';

  const labInput = document.createElement('input');
  labInput.type = 'text'; labInput.id = 'figLab'; labInput.className = 'field-in';
  labInput.placeholder = 'fig:energy (optional — enables \\ref)';
  let labEdited = false;
  labInput.addEventListener('input', () => { labEdited = true; });
  // auto-slug the label from the caption until the user touches the label field
  capInput.addEventListener('input', () => {
    if (!labEdited) labInput.value = capInput.value.trim() ? 'fig:' + slugifyLabel(capInput.value) : '';
  });

  const widthSel = document.createElement('select');
  widthSel.id = 'figW'; widthSel.className = 'field-in';
  for (const [v, t] of [['', 'Natural size'], ['50%', 'Half width (50%)'], ['75%', 'Three-quarters (75%)'], ['100%', 'Full width (100%)']]) {
    const o = document.createElement('option'); o.value = v; o.textContent = t; widthSel.appendChild(o);
  }

  const hiddenFile = document.createElement('input');
  hiddenFile.type = 'file'; hiddenFile.accept = 'image/*'; hiddenFile.style.display = 'none';
  pickBtn.addEventListener('click', () => hiddenFile.click());
  hiddenFile.addEventListener('change', async () => {
    const f = hiddenFile.files && hiddenFile.files[0];
    if (!f) return;
    if (f.size > IMG_MAX) { toast('That image is ' + mb(f.size) + ' — 10 MB is the embedding limit', { kind: 'error' }); return; }
    let stored;
    try { stored = await storeImage(f, f.type || 'image/png'); }
    catch { toast('Could not store the image locally', { kind: 'error' }); return; }
    pickedAsset = { ref: stored.ref, name: f.name };
    srcInput.value = stored.ref;
    if (!capInput.value) capInput.value = f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    capInput.dispatchEvent(new Event('input'));
    pickBtn.textContent = '✓ ' + f.name.slice(0, 22);
  });

  wrap.append(
    fieldRow('Image', srcRow, folderHandle
      ? 'Choose a file — it is saved into the project’s figs/ folder as a real file — or type a relative path (e.g. figs/plot.svg).'
      : 'Choose a file to embed it, or type a path to a file on disk next to '
        + 'this app (e.g. assets/figure.svg) — it loads straight from disk, no embedding.'),
    fieldRow('Caption', capInput),
    fieldRow('Label', labInput, 'Reference it elsewhere with \\ref{fig:…} or [](#fig:…).'),
    fieldRow('Width', widthSel),
    hiddenFile,
  );

  const doInsert = () => {
    const src = srcInput.value.trim();
    if (!src) { srcInput.focus(); toast('Choose an image or enter a source first'); return; }
    // escape ] in the caption and ) in the source so they can't break out of
    // the ![alt](src) syntax (CommonMark: backslash-escape inside link text/dest)
    const cap = capInput.value.trim().replace(/([[\]])/g, '\\$1');
    const srcEsc = mdPath(src);
    let label = labInput.value.trim();
    if (label && !/^(fig[:.])/i.test(label)) label = 'fig:' + label;
    const w = widthSel.value;
    let attr = '';
    if (label || w) {
      const parts = [];
      if (label) parts.push('#' + label.replace(/\./g, ':'));
      if (w) parts.push('width=' + w);
      attr = ' {' + parts.join(' ') + '}';
    }
    const md = '![' + cap + '](' + srcEsc + ')' + attr;
    closeDialog();
    insertBlockMd(md, 'Figure inserted' + (label ? ' — reference it with \\ref{' + label + '}' : ''));
  };

  wrap.appendChild(dialogActions([
    { label: 'Cancel', onClick: () => closeDialog() },
    { label: 'Insert figure', primary: true, onClick: doInsert },
  ]));
  openDialog({ title: 'Insert figure', body: wrap, initialFocus: '#figSrc' });
}

/* ---------- citation picker (search-as-you-type over the doc's bibliography) ----------
   Zotero-grade insertion without Zotero: every entry from the document's own
   ```bibtex fences plus its front-matter `bibliography:` document, filtered
   live on key/title/author/year; Enter or click inserts [@key] at the caret. */
async function collectBibEntries() {
  const parts = [];
  const src = editor.value;
  for (const m of src.matchAll(/```(?:bibtex|bib)[ \t]*\n([\s\S]*?)```/g)) parts.push(m[1]);
  try {
    const bibName = parseFrontMatter(src).meta.bibliography;
    if (bibName) { const d = await readDocContent(bibName); if (d) parts.push(d); }
  } catch { /* ignore */ }
  return [...parseBibtex(parts.join('\n\n')).entries.values()];
}
async function openCitePicker() {
  let entries;
  try { entries = await collectBibEntries(); } catch { entries = []; }
  if (!entries.length) {
    toast('No bibliography found — add a ```bibtex fence, or name a .bib document in front matter (bibliography: refs.bib)', { timeout: 8000 });
    return;
  }
  const wrap = document.createElement('div');
  const inp = document.createElement('input');
  inp.type = 'search'; inp.id = 'citeSearch'; inp.placeholder = 'Search key, title, author, year…';
  inp.setAttribute('aria-label', 'Search citations');
  const list = document.createElement('ul');
  list.className = 'cite-list';
  const insert = (key) => {
    closeDialog();
    const md = '[@' + key + ']';
    const s = editor.selectionStart ?? editor.value.length, e = editor.selectionEnd ?? s;
    applyEdit(editor, s, e, md);
    setDirty(true); scheduleRender(); scheduleAutosave();
    focusEditor();
    toast('Cited @' + key);
  };
  const hay = (en) => (en.key + ' ' + delatex(en.fields.title || '') + ' '
    + delatex(en.fields.author || en.fields.editor || '') + ' ' + (en.fields.year || '')).toLowerCase();
  const refill = () => {
    const terms = inp.value.toLowerCase().split(/\s+/).filter(Boolean);
    list.textContent = '';
    const hits = entries.filter((en) => terms.every((t) => hay(en).includes(t))).slice(0, 40);
    for (const en of hits) {
      const li = document.createElement('li');
      li.className = 'cite-item'; li.tabIndex = 0;
      const t = document.createElement('div'); t.className = 't';
      t.textContent = delatex(en.fields.title || '(no title)');
      const d = document.createElement('div'); d.className = 'd';
      d.textContent = '@' + en.key + ' · ' + delatex(en.fields.author || en.fields.editor || '—')
        + (en.fields.year ? ' · ' + delatex(en.fields.year) : '');
      li.append(t, d);
      li.addEventListener('click', () => insert(en.key));
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter') insert(en.key); });
      list.appendChild(li);
    }
    if (!hits.length) {
      const li = document.createElement('li'); li.className = 'cite-empty';
      li.textContent = 'No matches'; list.appendChild(li);
    }
  };
  inp.addEventListener('input', refill);
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const first = list.querySelector('.cite-item'); if (first) { e.preventDefault(); first.click(); } }
    else if (e.key === 'ArrowDown') { const first = list.querySelector('.cite-item'); if (first) { e.preventDefault(); first.focus(); } }
  });
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...list.querySelectorAll('.cite-item')];
    const idx = items.indexOf(document.activeElement);
    e.preventDefault();
    if (e.key === 'ArrowUp' && idx <= 0) { inp.focus(); return; }
    const next = items[Math.max(0, Math.min(items.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) next.focus();
  });
  refill();
  wrap.append(inp, list);
  openDialog({ title: 'Insert citation (' + entries.length + ' entries)', body: wrap, initialFocus: '#citeSearch' });
}

/* ---------- version history restore ---------- */
async function onRestore(v) {
  const name = state.currentName;
  try { await versionAdd(versionKey(name), editor.value, 'pre-restore'); } catch { /* ignore */ }
  applyEdit(editor, 0, editor.value.length, v.content);
  setDirty(true); scheduleRender(); scheduleAutosave();
  toast('Restored version from ' + new Date(v.ts).toLocaleString());
}
function openHistory() { openVersionHistory(state.currentName, { versionsList: (n) => versionsList(versionKey(n)), onRestore }); }

/* ---------- cheatsheet + settings dialogs ---------- */
let commands = [];
/* split a pretty shortcut into individual keycap labels: '⌘⇧O' → ['⌘','⇧','O'],
   'Ctrl+Shift+O' → ['Ctrl','Shift','O'] — so each key renders as its own cap */
function keyCaps(spec) {
  const p = prettyKeys(spec);
  if (p.includes('+')) return p.split('+');
  const mods = new Set(['⌘', '⌥', '⇧', '⌃']);
  const caps = []; let i = 0;
  while (i < p.length && mods.has(p[i])) { caps.push(p[i]); i++; }
  if (i < p.length) caps.push(p.slice(i));
  return caps.length ? caps : [p];
}
function openCheatsheet() {
  const table = document.createElement('table');
  table.className = 'kbd-table';
  for (const c of commands.filter((x) => x.keys && x.keys.length)) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td'); td1.textContent = c.title;
    const td2 = document.createElement('td');
    const combo = document.createElement('span'); combo.className = 'kbd-combo';
    for (const cap of keyCaps(c.keys[0])) {
      const kbd = document.createElement('kbd'); kbd.textContent = cap; combo.appendChild(kbd);
    }
    td2.appendChild(combo);
    tr.append(td1, td2); table.appendChild(tr);
  }
  openDialog({ title: 'Keyboard shortcuts', body: table });
}
function settingRow(labelText, descText, control) {
  const row = document.createElement('div'); row.className = 'setting-row';
  const left = document.createElement('div');
  const l = document.createElement('div'); l.className = 's-l'; l.textContent = labelText;
  const d = document.createElement('div'); d.className = 's-d'; d.textContent = descText;
  left.append(l, d); row.append(left, control);
  return row;
}
function selectControl(options, current, onChange) {
  const sel = document.createElement('select'); sel.style.width = 'auto'; sel.style.minWidth = '170px';
  for (const o of options) {
    const val = Array.isArray(o) ? o[0] : o, lab = Array.isArray(o) ? o[1] : o;
    const opt = document.createElement('option'); opt.value = val; opt.textContent = lab; if (val === current) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}
function updateSetting(key, val) { settings[key] = val; persistSettings(); }
function openSettings() {
  const wrap = document.createElement('div');
  const add = (label, desc, control) => wrap.appendChild(settingRow(label, desc, control));

  add('Editor text size', 'Size of the Markdown you type',
    selectControl([['12', '12 px'], ['13', '13 px'], ['14', '14 px'], ['15', '15 px'], ['16', '16 px'], ['17', '17 px'], ['18', '18 px']], String(settings.editorFontSize),
      (v) => { updateSetting('editorFontSize', +v); applySettings(); }));

  add('Editor font', 'Typeface of the editor (the preview is set by document Style)',
    selectControl([['mono', 'Monospace'], ['sans', 'Sans-serif'], ['serif', 'Serif']], settings.editorFontFamily,
      (v) => { updateSetting('editorFontFamily', v); applySettings(); }));

  add('Scroll sync anchor', 'Which line the two panes keep aligned when syncing',
    selectControl([['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']], settings.scrollAnchor,
      (v) => { updateSetting('scrollAnchor', v); }));

  add('App appearance', 'Chrome light, dark, or follow the system',
    selectControl([['auto', 'Follow system'], ['light', 'Light'], ['dark', 'Dark']], settings.appearance,
      (v) => { updateSetting('appearance', v); setChrome(v); }));

  add('Equation numbering', 'Default when a document sets none itself',
    selectControl([['auto', 'Auto — labelled only'], ['all', 'Number all display equations'], ['none', 'No numbers']], settings.eqNumbering,
      (v) => { updateSetting('eqNumbering', v); doRender(); }));

  add('Citation style', 'Default for documents without a front-matter override',
    selectControl([['numeric', 'Numeric  [1]'], ['author-year', 'Author–year  (Smith, 2021)']], settings.citationStyle,
      (v) => { updateSetting('citationStyle', v); state.citationStyle = v; doRender(); }));

  add('Autosave interval', 'How often a local draft is written as you type',
    selectControl([['500', 'Every 0.5 s'], ['1000', 'Every 1 s'], ['2000', 'Every 2 s']], String(settings.autosaveMs),
      (v) => { updateSetting('autosaveMs', +v); }));

  add('Spellcheck', 'Browser spellcheck in the editor',
    selectControl([['off', 'Off'], ['on', 'On']], settings.spellcheck ? 'on' : 'off',
      (v) => { updateSetting('spellcheck', v === 'on'); if (editor) editor.spellcheck = settings.spellcheck; }));

  add('Confirm before deleting', 'Ask first when a document is deleted (re-enable if you chose “don’t ask again”)',
    selectControl([['on', 'Ask first'], ['off', 'Delete immediately']], settings.confirmDelete === false ? 'off' : 'on',
      (v) => { updateSetting('confirmDelete', v === 'on'); }));

  const note = document.createElement('p'); note.className = 's-d'; note.style.marginTop = '14px';
  note.textContent = 'Everything stays on this device. Autosave keeps a local draft; an explicit save snapshots a version.';
  wrap.appendChild(note);
  openDialog({ title: 'Settings', body: wrap });
}

/* ---------- folder linking (File System Access API) ---------- */
/* file:// exposes showDirectoryPicker but every call throws SecurityError —
   for product purposes that host does NOT support folder projects. */
const folderSupported = () => 'showDirectoryPicker' in window && location.protocol !== 'file:';
let folderAssetsCache = [];                    // non-doc files (figures, PDFs) from the last folderList
const collapsedDirs = new Set();               // library-tree groups the user folded (per session)
const LIST_IGNORE = new Set(['colophon trash', 'node_modules']);   // matched lowercased — the fs is case-insensitive
async function folderList() {
  const docs = [], assets = [];
  let total = 0;
  async function scan(dir, prefix, depth) {
    for await (const h of dir.values()) {
      if (!prefix) total++;
      if (h.kind === 'directory') {
        if (depth >= 3 || h.name.startsWith('.') || LIST_IGNORE.has(h.name.toLowerCase())) continue;
        try { await scan(h, prefix + h.name + '/', depth + 1); } catch { /* unreadable subfolder — skip it */ }
      } else if (DOC_RE.test(h.name)) docs.push({ name: prefix + h.name });
      else if (ASSET_RE.test(h.name)) assets.push({ name: prefix + h.name });
    }
  }
  try {
    await scan(folderHandle, '', 0);
  } catch (e) {
    toast('Could not read “' + folderHandle.name + '”: ' + ((e && e.message) || e), { kind: 'error', timeout: 7000 });
    folderAssetsCache = assets;
    return docs;
  }
  if (!docs.length) {
    toast(total > 0
      ? 'No .md/.txt/.bib files in “' + folderHandle.name + '” (' + total + ' item' + (total === 1 ? '' : 's') + ' scanned)'
      : '“' + folderHandle.name + '” looks empty to the browser. Files with a “:” in the name (shown as “/” in Finder) are skipped by the browser — rename those; also check for undownloaded iCloud files.',
      { timeout: 9000 });
  }
  folderAssetsCache = assets.sort((a, b) => a.name.localeCompare(b.name));
  return docs.sort((a, b) => a.name.localeCompare(b.name));
}
/* Path-aware folder IO: every name may carry subfolders (figs/plot.svg).
   '..' segments are rejected everywhere — never walk out of the project. */
async function folderDirAt(relDir, create = false) {
  let dir = folderHandle;
  for (const s of String(relDir || '').split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') throw new Error('invalid path: ' + relDir);
    dir = await dir.getDirectoryHandle(s, { create });
  }
  return dir;
}
const splitRelPath = (p) => { const i = String(p).lastIndexOf('/'); return i === -1 ? ['', String(p)] : [String(p).slice(0, i), String(p).slice(i + 1)]; };
async function folderRead(name) { return (await folderReadFile(name)).text(); }
async function folderReadFile(name) { const [d, base] = splitRelPath(name); const h = await (await folderDirAt(d)).getFileHandle(base); return h.getFile(); }
async function folderWrite(name, text) { const [d, base] = splitRelPath(name); const h = await (await folderDirAt(d, true)).getFileHandle(base, { create: true }); const w = await h.createWritable(); await w.write(text); await w.close(); }
async function folderWriteBlob(name, blob) { const [d, base] = splitRelPath(name); const h = await (await folderDirAt(d, true)).getFileHandle(base, { create: true }); const w = await h.createWritable(); await w.write(blob); await w.close(); }
async function folderRemove(name) { const [d, base] = splitRelPath(name); await (await folderDirAt(d)).removeEntry(base); }
/* Resolve a RELATIVE path (subfolders allowed) to a File inside the linked
   folder — the offline-Overleaf model: figures are real files next to the
   document, referenced as ![...](figs/plot.png). */
async function folderFileAt(path) {
  const segs = decodeURIComponent(path).split('/').filter((s) => s && s !== '.');
  if (!segs.length || segs.some((s) => s === '..')) return null;   // never walk out of the project
  let dir = folderHandle;
  for (let i = 0; i < segs.length - 1; i++) dir = await dir.getDirectoryHandle(segs[i]);
  const fh = await dir.getFileHandle(segs[segs.length - 1]);
  return fh.getFile();
}
/* First free filename inside dirPath ('' = project root): name.png, name-2.png, … */
async function folderFreeName(base, ext, dirPath = '') {
  const clean = (base || 'image').replace(/[/\\:]/g, '-').trim() || 'image';
  const dir = await folderDirAt(dirPath, true);
  for (let i = 1; ; i++) {
    const cand = i === 1 ? clean + ext : clean + '-' + i + ext;
    try { await dir.getFileHandle(cand); } catch { return (dirPath ? dirPath + '/' : '') + cand; }
  }
}
/* A relative src (no scheme, not site-absolute) that the linked folder may hold. */
const isFolderRelativeSrc = (src) =>
  !!src && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith('/') && !src.startsWith('#');
/* ---------- projects (a project = a folder opened as a library) ----------
   Every folder ever opened is remembered as a project ({handle, lastDoc} in
   IDB meta 'projects'); the select in the Library panel switches between them
   and the in-browser library. The ACTIVE project is still the single
   folderHandle everything else already understands. */
let projects = [];
let activeProjectIdx = -1;
async function saveProjects() { try { await metaPut('projects', projects); } catch { /* ignore */ } }
async function projectIndexOf(handle) {
  if (!handle) return -1;
  for (let i = 0; i < projects.length; i++) {
    try { if (await projects[i].handle.isSameEntry(handle)) return i; } catch { /* ignore */ }
  }
  return -1;
}
async function loadProjects() {
  try { projects = (await metaGet('projects')) || []; } catch { projects = []; }
  projects = projects.filter((p) => p && p.handle && p.handle.queryPermission);
  let migrated = false;
  for (const p of projects) if (!p.id) { p.id = newAssetId(); migrated = true; }   // id namespaces the project's drafts
  const active = folderHandle || pendingFolder;
  if (active) {
    activeProjectIdx = await projectIndexOf(active);
    if (activeProjectIdx === -1) {          // legacy single-folder install → its folder becomes project #1
      projects.push({ id: newAssetId(), handle: active, lastDoc: null });
      activeProjectIdx = projects.length - 1;
      migrated = true;
    }
  }
  if (migrated) await saveProjects();
}
async function addProject(handle) {
  const i = await projectIndexOf(handle);
  if (i !== -1) { projects[i].handle = handle; await saveProjects(); return i; }
  projects.push({ id: newAssetId(), handle, lastDoc: null });
  await saveProjects();
  return projects.length - 1;
}
function rememberProjectDoc(name) {
  if (!folderHandle || activeProjectIdx < 0 || !projects[activeProjectIdx]) return;
  if (projects[activeProjectIdx].lastDoc === name) return;
  projects[activeProjectIdx].lastDoc = name;
  saveProjects();
}
/* Switch to a project (select change / boot reconnect). Runs in a user
   gesture when permission needs re-requesting. */
async function activateProject(i) {
  const p = projects[i];
  if (!p) return false;
  try {
    let perm = await p.handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') perm = await p.handle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') { toast('Permission was not granted for “' + p.handle.name + '”', { kind: 'error' }); return false; }
  } catch { toast('Could not open “' + (p.handle.name || 'project') + '”', { kind: 'error' }); return false; }
  revokeFolderUrls();
  folderHandle = p.handle; pendingFolder = null; activeProjectIdx = i;
  try { await metaPut('folderHandle', folderHandle); } catch { /* ignore */ }
  q('btnFolderRefresh').hidden = false;
  await refreshLibrary();
  updateLibPath();
  const names = docsCache.map((d) => d.name);
  const target = (p.lastDoc && names.includes(p.lastDoc)) ? p.lastDoc : names[0];
  if (target) { try { await loadDocByName(target); } catch { /* ignore */ } }
  toast('Project: ' + p.handle.name);   // p, not folderHandle — a concurrent switch may have nulled it
  return true;
}
async function useBrowserLibrary() {
  folderHandle = null; pendingFolder = null; activeProjectIdx = -1;
  revokeFolderUrls();
  try { await metaPut('folderHandle', null); } catch { /* ignore */ }
  q('btnFolderRefresh').hidden = true;
  await refreshLibrary();
  updateLibPath();
  if (docsCache.length) { try { await loadDocByName(docsCache[0].name); } catch { /* ignore */ } }
  toast('Using in-app storage');
}
async function forgetActiveProject() {
  const name = (folderHandle || pendingFolder) ? (folderHandle || pendingFolder).name : null;
  if (activeProjectIdx >= 0) { projects.splice(activeProjectIdx, 1); await saveProjects(); }
  await useBrowserLibrary();
  if (name) toast('Forgot “' + name + '” — its files are untouched on disk');
}

/* ---------- M3: migrate the in-app library into the active project ----------
   docs/ON_DISK_PROJECTS.md §5, verbatim contract: copy, don't move → state
   the literal destination → keep both until the USER deletes → quarantine
   name collisions with a suffix, never silently merge. Embedded
   colophon-asset: images are extracted into figs/ with references rewritten,
   and EVERY write — document or figure — is verified by reading it back
   before it counts. Nothing here ever deletes from IndexedDB. */
const legacyInfo = () => { try { return JSON.parse(localStorage.getItem('colophon-legacy-library') || 'null'); } catch { return null; } };
async function migrateLibraryToFolder() {
  if (!folderHandle) { toast('Open a project folder first (＋ Add folder…), then migrate into it'); return; }
  if (!(await ensureFolderWrite())) { toast('Folder write permission was not granted', { kind: 'error' }); return; }
  const docs = await docsAll();
  if (!docs.length) { toast('The in-app library is empty — nothing to migrate'); return; }
  const idSet = new Set();
  for (const d of docs) for (const id of assetRefs(d.content || '')) idSet.add(id);

  const go = await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); };
    const wrap = document.createElement('div');
    const p1 = document.createElement('p'); p1.style.marginTop = '0';
    p1.textContent = 'Copy ' + docs.length + ' document' + (docs.length === 1 ? '' : 's')
      + (idSet.size ? ' and ' + idSet.size + ' embedded figure' + (idSet.size === 1 ? '' : 's') + ' (into figs/)' : '')
      + ' into “' + folderHandle.name + '”. Every file is verified by reading it back after writing.';
    const p2 = document.createElement('p');
    p2.textContent = 'Nothing is deleted: your in-app library stays untouched until you empty it yourself, '
      + 'after you’ve checked the copies. A name that already exists in the folder is written with a '
      + '“-2” suffix, never overwritten.';
    wrap.append(p1, p2, dialogActions([
      { label: 'Cancel', onClick: () => { finish(false); closeDialog(); } },
      { label: 'Copy into “' + folderHandle.name + '”', primary: true, onClick: () => { finish(true); closeDialog(); } },
    ]));
    openDialog({ title: 'Move library into this project?', body: wrap, onClose: () => finish(false) });
  });
  if (!go) return;

  const report = { docs: [], figs: [], renamed: [], failed: [], missing: [] };
  // figures first, so every rewritten reference points at a VERIFIED file
  const assetMap = {};
  for (const id of idSet) {
    let a = null;
    try { a = await assetGet(id); } catch { /* treated as missing */ }
    if (!a || !a.blob) { report.missing.push(id); continue; }
    try {
      const name = await folderFreeName('figure', MIME_EXT[a.mime] || '.png', 'figs');
      await folderWriteBlob(name, a.blob);
      const back = await (await folderReadFile(name)).arrayBuffer();
      if (!bytesEqual(await a.blob.arrayBuffer(), back)) { report.failed.push(name + ' (read-back mismatch)'); continue; }
      assetMap[id] = mdPath(name);
      report.figs.push(name);
    } catch (e) { report.failed.push('figs/… for asset ' + id + ' (' + ((e && e.message) || e) + ')'); }
  }
  // documents — collision-suffixed against BOTH the live folder listing and
  // the names this very run has claimed (normalization-insensitive)
  let existing;
  try { existing = await folderList(); } catch { existing = docsCache; }
  const taken = new Set(existing.map((d) => normName(d.name)));
  for (const d of docs) {
    const text = rewriteAssetRefs(d.content || '', assetMap);
    let target = d.name;
    if (taken.has(normName(target))) {
      const base = target.replace(/\.[^.]+$/, ''), ext = (target.match(/\.[^.]+$/) || ['.md'])[0];
      for (let i = 2; ; i++) {
        const cand = base + '-' + i + ext;
        if (!taken.has(normName(cand))) { target = cand; break; }
      }
      report.renamed.push(d.name + ' → ' + target);
    }
    try {
      await folderWrite(target, text);
      const back = await folderRead(target);
      if (back !== text) { report.failed.push(target + ' (read-back mismatch)'); continue; }
      taken.add(normName(target));
      report.docs.push(target);
    } catch (e) { report.failed.push(target + ' (' + ((e && e.message) || e) + ')'); }
  }

  if (report.docs.length && !report.failed.length) {
    lsSet('colophon-legacy-library', JSON.stringify({ to: folderHandle.name, when: new Date().toISOString().slice(0, 10) }));
  }
  await refreshLibrary();
  updateLibPath();

  const wrap = document.createElement('div');
  const line = (t, strong) => { const p = document.createElement('p'); if (strong) p.style.fontWeight = '600'; p.textContent = t; wrap.appendChild(p); };
  line(report.docs.length + ' document' + (report.docs.length === 1 ? '' : 's')
    + (report.figs.length ? ' and ' + report.figs.length + ' figure' + (report.figs.length === 1 ? '' : 's') : '')
    + ' now live in “' + folderHandle.name + '”'
    + (report.figs.length ? ' (figures under figs/)' : '') + '.', true);
  if (report.renamed.length) line('Renamed to avoid overwriting: ' + report.renamed.join(', '));
  if (report.missing.length) line(report.missing.length + ' image reference' + (report.missing.length === 1 ? '' : 's') + ' had no stored image (left as-is in the text).');
  if (report.failed.length) line('FAILED (still safe in the in-app library): ' + report.failed.join('; '));
  line('Your in-app library was not modified. Check the copies open correctly, then empty it yourself: '
    + '⌘K → “Empty legacy in-app library”. Until then it stays listed as “Legacy (browser)”.');
  wrap.appendChild(dialogActions([{ label: 'Done', primary: true, onClick: () => closeDialog() }]));
  openDialog({ title: report.failed.length ? 'Migration finished with failures' : 'Library migrated', body: wrap });
}
/* The user-initiated end of §5: delete the in-app documents (and their bare-
   name version history/drafts) AFTER he has verified the folder copies.
   Assets are deliberately left alone — attached reference PDFs and images may
   still be used elsewhere, and orphans are harmless; assetsGCSafe() reclaims
   them whenever no folder projects exist. This is the ONLY code path that
   deletes in-app documents in bulk, and it never runs without this dialog. */
async function emptyLegacyLibrary() {
  const docs = await docsAll();
  if (!docs.length) {
    try { localStorage.removeItem('colophon-legacy-library'); } catch { /* ignore */ }
    browserDocsExist = false; updateLibPath();
    toast('The in-app library is already empty');
    return;
  }
  const go = await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); };
    const wrap = document.createElement('div');
    const p1 = document.createElement('p'); p1.style.marginTop = '0';
    p1.textContent = 'This permanently deletes the ' + docs.length + ' document' + (docs.length === 1 ? '' : 's')
      + ' stored inside this browser, with their version history. Files in your project folders on disk are NOT touched.';
    const p2 = document.createElement('p');
    p2.textContent = 'Only do this after opening the migrated copies in the project folder and confirming they are complete.';
    wrap.append(p1, p2, dialogActions([
      { label: 'Cancel', primary: true, onClick: () => { finish(false); closeDialog(); } },
      { label: 'Delete ' + docs.length + ' document' + (docs.length === 1 ? '' : 's'), onClick: () => { finish(true); closeDialog(); } },
    ]));
    openDialog({ title: 'Empty the in-app library?', body: wrap, onClose: () => finish(false) });
  });
  if (!go) return;
  let removed = 0;
  for (const d of docs) {
    // browser-library keys are the BARE name (per-project prefixes only apply
    // in folder mode) — clear with the bare name regardless of current mode
    try { await versionsClear(d.name); } catch { /* ignore */ }
    try { await draftClear(d.name); } catch { /* ignore */ }
    try { await docDelete(d.name); removed++; } catch { /* ignore */ }
  }
  try { localStorage.removeItem('colophon-legacy-library'); } catch { /* ignore */ }
  browserDocsExist = (await docsAll()).length > 0;
  if (!folderHandle) await refreshLibrary();
  updateLibPath();
  toast('Deleted ' + removed + ' in-app document' + (removed === 1 ? '' : 's') + ' — your project folders are untouched');
}
/* The project bar: a select of projects (+ the in-app fallback library only
   when it is actually relevant), Add-folder, and a Reconnect button when the
   active project needs its permission click. Folder-first (a product decision,
   2026-07-09): on capable hosts the in-app library is a demoted fallback —
   listed only while it still holds documents or nothing else exists; on
   hosts without the folder API (file://, sandboxed iframes) it IS the
   storage, shown as a single plain entry with the Add button hidden. */
let browserDocsExist = false;   // refreshed at boot + whenever the in-app library is the active mode
function updateLibPath() {
  const sel = q('projectSelect'), choose = q('btnChooseFolder'), reconnect = q('btnReconnectFolder');
  if (!sel) return;
  sel.textContent = '';
  const opt = (v, label, title) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = label; if (title) o.title = title;
    sel.appendChild(o);
  };
  const inBrowser = !folderHandle && !pendingFolder;
  const onFile = location.protocol === 'file:';
  if (!folderSupported()) {
    opt('browser', '💻 This computer (in-app storage)', 'Documents are stored inside this app; folder projects need the app served over http or the desktop version');
    // Keep the affordance VISIBLE on file:// (hiding it made the feature look
    // gone); clicking it explains why folders are unavailable here. On file://
    // the browser blocks the folder API outright — not fixable client-side.
    if (choose) {
      choose.hidden = false;
      choose.title = onFile
        ? 'Folder projects are blocked on file:// pages — open Colophon over http(s) or use the desktop app'
        : 'Folder projects need a Chromium browser';
    }
    if (reconnect) reconnect.hidden = true;
    sel.value = 'browser';
    return;
  }
  if (browserDocsExist || inBrowser || !projects.length) {
    const mig = legacyInfo();
    if (mig && browserDocsExist) {
      opt('browser', '🗂 Legacy (browser) — migrated to “' + mig.to + '”',
        'The pre-migration copy inside this browser. Verify the project copies, then empty it: ⌘K → “Empty legacy in-app library”');
    } else {
      opt('browser', '🗂 In-app storage', 'The fallback library inside this browser profile — projects (real folders) are the recommended home');
    }
  }
  projects.forEach((p, i) => opt('p' + i, '📁 ' + p.handle.name
    + (i === activeProjectIdx && pendingFolder && !folderHandle ? ' — needs permission' : '')));
  sel.value = !inBrowser && activeProjectIdx >= 0 ? 'p' + activeProjectIdx : 'browser';
  if (reconnect) reconnect.hidden = !(pendingFolder && !folderHandle);
  if (choose) {
    choose.hidden = false;
    choose.title = 'Open a folder as a project';
  }
}
/* Shown ONLY when the user actively clicks Add-folder on a file:// page — not
   auto-nagged. Accurate: in-app storage persists fine here (IndexedDB works on
   file://); it is ONLY the folder-picker API the browser blocks on file://. */
function explainFolderOnFile() {
  toast('Folders-on-disk need the app served over http(s) or the desktop version — the browser '
    + 'blocks the folder picker on file:// pages. Your in-app library here still saves and persists '
    + 'normally; you can also Export any document to a .md file on disk.', { timeout: 11000 });
}
async function linkFolder() {
  if (!folderSupported()) {
    if (location.protocol === 'file:') { explainFolderOnFile(); return; }
    toast('Folder projects need a Chromium browser (Chrome, Edge, Arc…)'); return;
  }
  let h;
  try { h = await window.showDirectoryPicker({ mode: 'readwrite' }); }   // read + write (Save writes back)
  catch (e) {
    if (e && e.name === 'AbortError') return;             // user dismissed the picker
    if (e && e.name === 'SecurityError' && location.protocol === 'file:') { toast('Folder access is blocked when opening the file directly (file://). Serve it over http, or use in-browser storage.', { kind: 'error', timeout: 8000 }); return; }
    toast('Folder link failed: ' + ((e && e.message) || e), { kind: 'error', timeout: 7000 });
    return;
  }
  revokeFolderUrls();
  folderHandle = h; pendingFolder = null;
  activeProjectIdx = await addProject(h);
  try { await metaPut('folderHandle', folderHandle); } catch { /* ignore */ }
  q('btnFolderRefresh').hidden = false;
  await refreshLibrary();
  updateLibPath();
  // in-app documents waiting + no prior migration → the §5 offer takes
  // precedence over starters (an empty folder about to receive a library
  // must not get starter docs mixed into it first)
  const offerMigration = browserDocsExist && !legacyInfo();
  if (!docsCache.length && !offerMigration) {
    // an empty folder gets the same starter offer onboarding gives — but
    // explicitly: an intentionally-empty project must stay empty
    toast('“' + folderHandle.name + '” is empty — add the starter documents (welcome, LaTeX demo, figure)?', {
      actionLabel: 'Add starters',
      onAction: async () => {
        const seeded = await seedFolderIfEmpty();
        await refreshLibrary();
        if (seeded) await loadDocByName('Welcome.md');
      },
      timeout: 10000,
    });
  } else if (docsCache.length) {
    // open something from the new project immediately — leaving the previous
    // document in the editor meant ⌘S would write it into the new folder
    const names = docsCache.map((d) => d.name);
    const target = names.includes('Welcome.md') ? 'Welcome.md' : names[0];
    if (target) { try { await loadDocByName(target); } catch { /* ignore */ } }
    toast('Project: ' + folderHandle.name);
  }
  // in-app documents + a freshly linked folder → the §5 migration offer
  if (offerMigration) {
    toast('Your in-app library can move into “' + folderHandle.name + '” as real files (copies — nothing deleted)', {
      actionLabel: 'Migrate library',
      onAction: () => migrateLibraryToFolder(),
      timeout: 12000,
    });
  }
}
/* 'granted' → folderHandle live; 'prompt' → pendingFolder set, needs a click
   (reconnectFolder); 'none' → no stored folder. The 'prompt' state must NOT
   silently fall back to the in-browser library — a folder user would see the
   seeded starter docs instead of their real documents. */
async function restoreFolder() {
  try {
    const h = await metaGet('folderHandle');
    if (!h || !h.queryPermission) return 'none';
    const p = await h.queryPermission({ mode: 'read' });
    if (p === 'granted') { folderHandle = h; q('btnFolderRefresh').hidden = false; return 'granted'; }
    if (p === 'prompt') { pendingFolder = h; return 'prompt'; }
  } catch { /* ignore */ }
  return 'none';
}
/* Must run inside a user gesture (requestPermission requires one). */
async function reconnectFolder() {
  if (!pendingFolder) return false;
  try {
    if ((await pendingFolder.requestPermission({ mode: 'readwrite' })) !== 'granted') return false;
  } catch { return false; }
  folderHandle = pendingFolder; pendingFolder = null;
  if (activeProjectIdx === -1) activeProjectIdx = await projectIndexOf(folderHandle);
  q('btnFolderRefresh').hidden = false;
  await refreshLibrary();
  updateLibPath();
  // per-project memory first — the global colophon-last may point into a
  // DIFFERENT scope's same-named document
  const projLast = activeProjectIdx >= 0 && projects[activeProjectIdx] ? projects[activeProjectIdx].lastDoc : null;
  let last = null; try { last = localStorage.getItem('colophon-last'); } catch { /* ignore */ }
  const names = docsCache.map((d) => d.name);
  const target = (projLast && names.includes(projLast)) ? projLast
    : (last && names.includes(last)) ? last : names[0];
  if (target) { try { await loadDocByName(target); } catch { /* ignore */ } }
  toast('Reconnected to “' + folderHandle.name + '”');
  return true;
}

/* Starter documents become real files in a folder the user just chose — but
   only when the folder holds no documents yet (never pollute an existing one).
   The showcase figure is written as a real image file too, and the seed text
   is rewritten to reference it by relative path — on disk, everything in the
   project is a plain file (the offline-Overleaf model). */
async function seedFolderIfEmpty() {
  try {
    for await (const h of folderHandle.values()) {
      if (h.kind === 'file' && DOC_RE.test(h.name)) return false;   // the app's own doc set — a .bib-only folder is NOT empty
    }
  } catch { return false; }
  for (const s of SEED_DOCS) {
    let content = s.content;
    for (const a of SEED_ASSETS) if (a.file) {
      content = content.split('colophon-asset:' + a.id).join(a.file);
      // the browser copy references assets/<name> (shipped next to the app);
      // in a project the same figure lives at figs/<name> — rewrite those too
      content = content.split('assets/' + a.file.split('/').pop()).join(a.file);
    }
    try { await folderWrite(s.name, content); lsSet('colophon-seeded:' + s.name, '1'); } catch { /* ignore */ }
  }
  for (const a of SEED_ASSETS) {
    if (!a.file) continue;
    try { await folderWriteBlob(a.file, new Blob([a.content], { type: a.mime })); } catch { /* ignore */ }
  }
  return true;
}

/* First-run onboarding: documents live in a real folder by default — the
   in-browser library is the fallback, not the home. Resolves 'folder' once a
   folder is linked (and seeded/opened), or 'browser' on decline/dismiss. */
function offerFolderFirstRun() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); };
    const wrap = document.createElement('div');
    const intro = document.createElement('p');
    intro.style.marginTop = '0';
    intro.textContent = 'Colophon is a private, offline document studio — nothing you write leaves '
      + 'this machine. First: where should your documents live?';
    const grid = document.createElement('div');
    grid.className = 'tpl-grid choice-grid';
    const card = (emoji, title, badge, desc, onClick) => {
      const c = document.createElement('button');
      c.type = 'button'; c.className = 'tpl-card';
      const tt = document.createElement('div'); tt.className = 't';
      tt.textContent = emoji + ' ' + title;
      if (badge) { const b = document.createElement('span'); b.className = 'chip'; b.textContent = badge; tt.append(' ', b); }
      const dd = document.createElement('div'); dd.className = 'd'; dd.textContent = desc;
      c.append(tt, dd);
      c.addEventListener('click', onClick);
      return c;
    };
    grid.append(
      card('📁', 'A folder on disk', 'Recommended', 'Your documents and figures are real files in a '
        + 'folder you choose: visible in Finder, covered by your backups, editable in any other '
        + 'app. An empty folder gets three small starter documents (delete them freely).', async () => {
        let h;
        try { h = await window.showDirectoryPicker({ mode: 'readwrite' }); }
        catch (e) { if (e && e.name === 'AbortError') return; toast('Folder access failed: ' + ((e && e.message) || e), { kind: 'error' }); return; }
        folderHandle = h;
        activeProjectIdx = await addProject(h);
        try { await metaPut('folderHandle', folderHandle); } catch { /* ignore */ }
        q('btnFolderRefresh').hidden = false;
        const seeded = await seedFolderIfEmpty();
        await refreshLibrary();
        updateLibPath();
        closeDialog();
        const target = seeded ? 'Welcome.md' : (docsCache[0] && docsCache[0].name);
        if (target) await loadDocByName(target); else await createUntitled();
        toast('Your library lives in “' + folderHandle.name + '”' + (seeded ? ' — starter documents added' : ''));
        finish('folder');
      }),
      card('🗂', 'In-app storage', null, 'Stored privately inside this browser profile — fine for a quick '
        + 'try. You can move to a folder any time (Library → ＋ Add folder…).', () => { closeDialog(); finish('browser'); }),
    );
    wrap.append(intro, grid);
    openDialog({ title: 'Welcome to Colophon', body: wrap, onClose: () => finish('browser') });
  });
}

/* A returning folder-mode session: ask for the one permission click up front
   instead of silently dumping the user into the in-browser starter library. */
function offerReconnect() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); };
    const wrap = document.createElement('div');
    const p = document.createElement('p');
    p.style.marginTop = '0';
    const strong = document.createElement('strong'); strong.textContent = pendingFolder ? pendingFolder.name : '';
    p.append('Your library lives in the folder ', strong,
      document.createTextNode(' — the browser needs one click of permission to reopen it each session.'));
    const tip = document.createElement('p');
    tip.className = 's-d';
    tip.textContent = 'Tip: if Chrome shows “Allow on every visit”, choosing it skips this step for good.';
    wrap.append(p, tip, dialogActions([
      { label: 'Use browser library instead', onClick: () => { closeDialog(); finish(false); } },
      { label: 'Open my folder', primary: true, onClick: async () => {
        const ok = await reconnectFolder();
        closeDialog();
        if (!ok) toast('Permission was not granted — using the in-browser library (Reconnect is in the Library panel)', { timeout: 8000 });
        finish(ok);
      } },
    ]));
    openDialog({ title: 'Reopen your library folder', body: wrap, onClose: () => finish(false) });
  });
}

/* ---------- import (drag-drop / open) ---------- */
async function addFiles(fileList) {
  let last = null;
  const images = [];
  await refreshLibrary();
  // Imports NEVER overwrite: a colliding name gets -2/-3… (normalization- and
  // case-folded — the fs treats Report.md/report.md as one file).
  const taken = new Set(docsCache.map((d) => normName(d.name)));
  const freeName = (raw) => {
    if (!taken.has(normName(raw))) { taken.add(normName(raw)); return raw; }
    const ext = (raw.match(/\.[^.]+$/) || ['.md'])[0];
    const base = raw.slice(0, raw.length - ext.length);
    for (let i = 2; ; i++) {
      const c = base + '-' + i + ext;
      if (!taken.has(normName(c))) { taken.add(normName(c)); toast('Added as ' + c + ' — ' + raw + ' already exists'); return c; }
    }
  };
  for (const f of fileList) {
    const nm = freeName(f.name);
    if (/\.(md|markdown|mdown|txt)$/i.test(nm)) {
      // mode-consistent write; a folder failure must SAY so, not silently
      // land the file in the other storage where the library won't show it
      try { await writeNewDoc(nm, await f.text()); } catch { toast('Could not add ' + nm, { kind: 'error' }); continue; }
      last = nm;
    } else if (/\.(tex|latex)$/i.test(nm)) {
      // kept as a real .tex file — the preview renders it via the live
      // conversion, and opening it offers an editable .md copy
      const text = await f.text();
      try { await writeNewDoc(nm, text); } catch { toast('Could not add ' + nm, { kind: 'error' }); continue; }
      last = nm;
    } else if (/\.bib$/i.test(nm)) {
      try { await writeNewDoc(nm, await f.text()); } catch { toast('Could not add ' + nm, { kind: 'error' }); continue; }   // .bib lives in the library as a document
      last = nm;
    } else if (/^image\//.test(f.type) || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(nm)) {
      images.push(f);
    }
  }
  await refreshLibrary();
  if (last) { try { await loadDocByName(last); } catch { /* ignore */ } }
  for (const f of images) await insertImageBlob(f, f.type);   // drop images into the current doc, at the caret
  return last;
}

/* ---------- images (paste / drop / insert) ---------- */
const IMG_CONFIRM = 2 * 1024 * 1024, IMG_MAX = 10 * 1024 * 1024;
const mb = (n) => (n / (1024 * 1024)).toFixed(1) + ' MB';
function newAssetId() {
  try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 8); } catch { /* ignore */ }
  return Math.random().toString(36).slice(2, 10);
}
function confirmDialog(title, message) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); };
    const wrap = document.createElement('div');
    const p = document.createElement('p'); p.style.marginTop = '0'; p.textContent = message;
    wrap.append(p, dialogActions([
      // finish BEFORE closeDialog: closeDialog fires onClose → finish(false)
      // would win the race and every confirm would silently resolve false
      { label: 'Cancel', onClick: () => { finish(false); closeDialog(); } },
      { label: 'Insert', primary: true, onClick: () => { finish(true); closeDialog(); } },
    ]));
    openDialog({ title, body: wrap, onClose: () => finish(false) });
  });
}
const MIME_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'image/bmp': '.bmp', 'image/avif': '.avif' };
/* In a project (folder mode) the image becomes a REAL file next to the
   document, referenced by relative path — like an offline Overleaf. The
   in-browser library keeps using the asset store. */
let imageWriteChain = Promise.resolve();   // serialize probe→write: overlapping pastes must not claim the same free name
async function storeImage(blob, mime) {
  const type = mime || blob.type || 'image/png';
  if (folderHandle) {
    const job = imageWriteChain.then(async () => {
      if (!(await ensureFolderWrite())) throw new Error('folder write permission denied');
      const base = (blob.name || 'pasted-image').replace(/\.[^.]+$/, '');
      const name = await folderFreeName(base, MIME_EXT[type] || '.png', 'figs');   // images live in figs/ — per-project, Typora-style
      await folderWriteBlob(name, blob);
      folderUrlCache.delete(name);                      // a re-used name must re-resolve
      refreshLibrary().catch(() => { /* tree refresh is cosmetic */ });   // show the new file in the tree
      return { ref: name, where: 'saved to the project as ' + name };
    });
    imageWriteChain = job.catch(() => { /* a failed write must not poison the chain */ });
    return job;
  }
  const id = newAssetId();
  await assetPut(id, blob, type);
  return { ref: 'colophon-asset:' + id, where: 'stored in this browser' };
}
async function insertImageBlob(blob, mime) {
  if (!blob || !blob.size) return;
  if (isTexDoc()) { toast('This is a LaTeX document — paste images into a Markdown document instead.', { kind: 'error', timeout: 7000 }); return; }
  if (blob.size > IMG_MAX) { toast('That image is ' + mb(blob.size) + ' — 10 MB is the embedding limit'); return; }
  if (!folderHandle && blob.size > IMG_CONFIRM) {       // on disk, size only matters at export time
    const ok = await confirmDialog('Large image', 'This image is ' + mb(blob.size) + '. Large images make the app and your exports heavier. Insert it anyway?');
    if (!ok) return;
  }
  let stored;
  try { stored = await storeImage(blob, mime); }
  catch { toast('Could not store the image locally'); return; }
  const md = '![](' + mdPath(stored.ref) + ')';         // macOS screenshots carry spaces — raw they kill the parse
  const s = editor.selectionStart ?? editor.value.length, e = editor.selectionEnd ?? s;
  applyEdit(editor, s, e, md, [s + 2, s + 2]);           // caret inside the empty alt-text brackets
  setDirty(true); scheduleRender(); scheduleAutosave();
  toast('Image inserted (' + stored.where + ') — type alt text between the brackets');
}
function insertImagesFromFiles(files) {
  const imgs = [...files].filter((f) => /^image\//.test(f.type) || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name));
  (async () => { for (const f of imgs) await insertImageBlob(f, f.type); })();
  return imgs.length;
}
function pasteImage(e) {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const it of items) {
    if (it.kind === 'file' && /^image\//.test(it.type)) {
      const f = it.getAsFile();
      if (f) { e.preventDefault(); insertImageBlob(f, it.type); return; }
    }
  }
}

/* ---------- PDF-linked references ----------
   Right-click a reference entry (li id="ref-<key>") in the preview to attach
   the paper's PDF. The blob lives in the asset store as refpdf-<key> — keyed
   by cite key, so a bibliography shared across documents shares the PDF. A
   small "PDF" tab is appended to the entry after every render (live preview
   only; applyPostDom for exports never sees it), built with createElement —
   nothing bypasses the sanitized pipeline HTML. */
let refPdfs = new Set();                 // cite keys with an attached PDF (meta 'refpdfs')
const refPdfUrls = new Map();            // key → blob URL, session-lived
const PDF_MAX = 25 * 1024 * 1024;
function decorateRefPdfs() {
  // Live preview only (exports never call this). Every reference entry now
  // carries an affordance so the feature is discoverable without a right-click:
  // an "Open PDF" chip when one is attached, else a hover-revealed "＋ PDF"
  // that attaches one. This is the whole "link a PDF to a reference" feature —
  // it used to be invisible until after you'd somehow already attached one.
  for (const li of preview.querySelectorAll('.references li[id^="ref-"]')) {
    const key = li.id.slice(4);
    if (li.querySelector('.ref-pdf, .ref-pdf-add')) continue;   // already decorated this render
    if (refPdfs.has(key)) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'ref-pdf'; b.textContent = '📄 PDF';
      b.title = 'Open the attached PDF (right-click the reference to replace or remove it)';
      b.addEventListener('click', () => openRefPdf(key));
      li.append(' ', b);
    } else {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'ref-pdf-add'; b.textContent = '＋ PDF';
      b.title = 'Attach a PDF of this reference (stored locally; opens from the chip)';
      b.addEventListener('click', () => attachRefPdf(key));
      li.append(' ', b);
    }
  }
}
async function openRefPdf(key) {
  try {
    if (!refPdfUrls.has(key)) {
      const a = await assetGet('refpdf-' + key);
      if (!a || !a.blob) { toast('The attached PDF is missing from local storage', { kind: 'error' }); return; }
      refPdfUrls.set(key, URL.createObjectURL(a.blob));
    }
    openAssetViewer('attached PDF — ' + key, { url: refPdfUrls.get(key) }, { kind: 'pdf' });
  } catch { toast('Could not open the PDF', { kind: 'error' }); }
}
function attachRefPdf(key) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'application/pdf,.pdf'; inp.style.display = 'none';
  document.body.appendChild(inp);
  inp.addEventListener('change', async () => {
    const f = inp.files && inp.files[0];
    inp.remove();
    if (!f) return;
    if (f.size > PDF_MAX) { toast('That PDF is ' + mb(f.size) + ' — 25 MB is the limit', { kind: 'error' }); return; }
    try { await assetPut('refpdf-' + key, f, 'application/pdf'); }
    catch { toast('Could not store the PDF locally', { kind: 'error' }); return; }
    const old = refPdfUrls.get(key);
    if (old) { try { URL.revokeObjectURL(old); } catch { /* ignore */ } refPdfUrls.delete(key); }
    refPdfs.add(key);
    try { await metaPut('refpdfs', [...refPdfs]); } catch { /* ignore */ }
    doRender();
    toast('PDF attached to [@' + key + '] — a PDF tab now sits on the reference');
  });
  inp.click();
}
async function removeRefPdf(key) {
  try { await assetDelete('refpdf-' + key); } catch { /* ignore */ }
  const old = refPdfUrls.get(key);
  if (old) { try { URL.revokeObjectURL(old); } catch { /* ignore */ } refPdfUrls.delete(key); }
  refPdfs.delete(key);
  try { await metaPut('refpdfs', [...refPdfs]); } catch { /* ignore */ }
  doRender();
  toast('PDF removed from [@' + key + '] (the original file on disk is untouched)');
}
/* asset ids that document-text scanning can't account for and GC must keep:
   seeds, attached PDFs, and anything referenced by the OPEN editor (an
   insert's reference lives only in editor.value until autosave lands). */
const protectedAssetIds = () => [
  ...SEED_ASSETS.map((a) => a.id),
  ...[...refPdfs].map((k) => 'refpdf-' + k),
  ...[...editor.value.matchAll(/colophon-asset:([\w-]+)/g)].map((m) => m[1]),
];
/* GC only when no folder projects exist at all — their documents can hold
   colophon-asset: references the IDB scan can't see. */
const assetsGCSafe = () => (projects.length ? Promise.resolve(0) : assetsGC(protectedAssetIds()));

/* ---------- exporter context ---------- */
/* Exports run on previewSource(): what you see is what exports — a .tex doc
   exports its converted-Markdown rendering. The one exception is the LaTeX
   export of a .tex doc, which passes the raw source through unchanged
   (round-tripping LaTeX→MD→LaTeX would be lossy for no reason). */
function exportTexSmart() {
  if (isTexDoc() && looksLikeLatex(editor.value)) {   // same gate as previewSource/latexImport
    download(state.currentName, editor.value, 'application/x-tex;charset=utf-8');
    toast('Exported the LaTeX source as-is');
    return;
  }
  exportTex(exportCtx);
}
const exportCtx = {
  getSource: () => previewSource(),
  renderOpts: () => renderOpts(previewSource()),
  // folder mode: relative image paths are project files — exports inline them.
  // Contract: undefined = no folder / capability (leave the src untouched);
  // null = folder looked, file missing (exporter marks it missing).
  resolveLocalImage: async (path) => {
    if (!folderHandle) {
      // No project linked: the live preview loads relative paths natively —
      // exports must inline the same file or HTML/DOCX silently lose figures.
      // fetch works over http(s) (the launcher origin); where it can't
      // (file://), leave the img as-authored rather than stamping it missing.
      let p = path; try { p = decodeURIComponent(path); } catch { /* raw */ }
      if (!isSafeRelPath(p)) return null;
      try {
        const r = await fetch(new URL(path, location.href));   // same resolution the <img> uses
        if (r.ok) return await r.blob();
      } catch { /* fall through */ }
      return undefined;
    }
    try { return (await folderFileAt(path)) || null; } catch { return null; }
  },
  themeClass: () => 'theme-' + state.theme,
  styleClass: () => 'style-' + state.docStyle,
  currentName: () => state.currentName,
  render: doRender,
  mermaid,
};

/* ---------- clipboard (code copy) ---------- */
function copyText(t) {
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).catch(() => fallbackCopy(t));
  else fallbackCopy(t);
}
function fallbackCopy(t) {
  const ta = document.createElement('textarea');
  ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.focus(); ta.select();
  try { document.execCommand('copy'); } catch { /* ignore */ }
  ta.remove();
}

/* ============================================================================
   Wiring
   ============================================================================ */
const ctx = {
  editor,
  save: explicitSave,
  openPalette: (o) => palette.open(o),
  openFind: () => findbar.open(),
  newDoc, newFromTemplate, newFromClipboard,
  openFile: () => fileInput.click(),
  rename, duplicate,
  deleteDoc: () => deleteDoc(),
  openHistory, linkFolder,
  setView, toggleSidebar: () => sidebar.toggle(),
  // on a .tex doc the palette command makes the .md copy (in-place rewrite
  // would leave Markdown under a .tex name); elsewhere it converts in place
  latexImport: () => (isTexDoc() && looksLikeLatex(editor.value)) ? convertTexToMdCopy() : runLatexImport(),
  insertFigure: openInsertFigure,
  insertCitation: openCitePicker,
  openCheatsheet, openSettings,
  exportPdf: () => exportPdf(exportCtx),
  exportHtml: () => exportHtml(exportCtx),
  exportWordCopy: () => exportWordCopy(exportCtx),
  exportDocx: () => exportDocx(exportCtx),
  exportMarkdown: () => exportMarkdown(exportCtx),
  exportTex: () => exportTexSmart(),
  openExportMenu: () => { exportMenu.hidden = !exportMenu.hidden; if (!exportMenu.hidden) { const am = q('appearanceMenu'); if (am) am.hidden = true; } },
  insertImage: () => q('imgInput').click(),
  openDoc: (n) => loadDocByName(n),
  docNames: () => docsCache.map((d) => d.name),
  focusEditor,
  // "focus is in the editor" must include the flagged CodeMirror surface
  isEditorFocused: () => document.activeElement === editor
    || !!(cm && cm.contentDOM.contains(document.activeElement)),
};

commands = createCommands(ctx);
commands.push(
  { id: 'new-clipboard', title: 'New from clipboard', cat: 'File', keys: ['Mod+Alt+V'], run: () => ctx.newFromClipboard() },
  { id: 'migrate-library', title: 'Migrate in-app library into this project…', cat: 'File', keys: [], run: () => migrateLibraryToFolder() },
  { id: 'empty-legacy', title: 'Empty legacy in-app library…', cat: 'File', keys: [], run: () => emptyLegacyLibrary() },
  { id: 'insert-image', title: 'Insert image…', cat: 'Insert', keys: [], run: () => ctx.insertImage() },
  { id: 'insert-citation', title: 'Insert citation… (search your bibliography)', cat: 'Insert', keys: ['Mod+Shift+O'], run: () => ctx.insertCitation() },
  { id: 'export-docx', title: 'Export: Word .docx (native equations)', cat: 'Export', keys: [], run: () => ctx.exportDocx() },
  { id: 'export-tex', title: 'Export: LaTeX .tex', cat: 'Export', keys: [], run: () => ctx.exportTex() },
  { id: 'export-menu', title: 'Export…', cat: 'Export', keys: ['Mod+Shift+E'], run: () => ctx.openExportMenu() },
  { id: 'toggle-sync', title: 'Toggle sync scrolling', cat: 'View', keys: [], run: () => setScrollSync(!scrollSyncOn) },
);
const palette = createPalette(commands, ctx);
const findbar = createFindbar(editor);
editor.addEventListener('scroll', updateScrollCues, { passive: true });   // the highlight scrolls itself (background-attachment:local)
previewPane.addEventListener('scroll', updateScrollCues, { passive: true });
window.addEventListener('resize', () => { clampSplit(); updateScrollCues(); updatePageBreaks(); markSyncMapDirty(); });
// KaTeX/webfonts settle after first render — block heights change, so re-paginate
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { updatePageBreaks(); markSyncMapDirty(); });
document.addEventListener('selectionchange', onSelectionChange);   // block-level selection mirroring

/* Smart copy from the preview: rendered equations/tables become clean LaTeX /
   pipe-table source instead of KaTeX garbage; prose stays plain text. Only
   fires for a real selection inside the preview — the editor and everything
   else keep the native clipboard behavior. */
preview.addEventListener('copy', (e) => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  if (!preview.contains(sel.anchorNode) || !preview.contains(sel.focusNode)) return;
  let md = '';
  try {
    const holder = document.createElement('div');
    holder.appendChild(sel.getRangeAt(0).cloneContents());
    md = serializeSelection(holder);
  } catch { return; }
  if (!md) return;
  e.clipboardData.setData('text/plain', md);
  e.preventDefault();
});
const sidebar = initSidebar({ onToggle: () => { clampSplit(); updatePageBreaks(); markSyncMapDirty(); } });
bindShortcuts(commands, ctx, { isBlocked: () => palette.isOpen() || isDialogOpen() });

/* editor */
editor.addEventListener('input', () => { setDirty(true); scheduleRender(); scheduleAutosave(); clearEditorHighlight(); lastMirror = null; });
editor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') { e.preventDefault(); const s = editor.selectionStart, en = editor.selectionEnd; applyEdit(editor, s, en, '  ', [s + 2, s + 2]); }
  // Enter continues a list/task/quote; on an empty item it exits the list
  else if (e.key === 'Enter' && !e.isComposing && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey
           && editor.selectionStart === editor.selectionEnd) {
    const r = listContinuation(editor.value, editor.selectionStart);
    if (r) { e.preventDefault(); applyEdit(editor, r.from, r.to, r.insert, [r.caret, r.caret]); }
  }
});
editor.addEventListener('paste', pasteImage);   // pasted image → local asset (text paste falls through)
editor.addEventListener('paste', offerLatexPaste); // large LaTeX-looking paste → offer conversion

/* ---------- CodeMirror editor (migration Phase 2, feature-flagged) ----------
   Enable with ?cm=1 or localStorage colophon-cm=1. CM becomes the typing
   surface; the (hidden) textarea REMAINS the source of truth every existing
   feature reads and writes, kept identical by a two-way bridge:
     CM edit  → textarea.value + synthetic 'input'  (render/dirty/autosave run)
     textarea 'input' (applyEdit, loads, find)      → cm.setValue
   Phase 3 re-points the callsites to the adapter; Phase 5 rebuilds sub-block
   mirroring on CM geometry. Known rough under the flag (documented in
   docs/CODEMIRROR_MIGRATION.md): findbar match highlight isn't visible (it
   selects inside the hidden textarea) — edits/replace-all still work. */
const cmWanted = /[?&]cm=1/.test(location.search)
  || (() => { try { return localStorage.getItem('colophon-cm') === '1'; } catch { return false; } })();
if (cmWanted) {
  const pane = document.querySelector('.editor-pane');
  let bridging = false;
  cm = createEditor({
    parent: pane,
    doc: editor.value,
    onDocChange: () => {
      if (bridging) return;
      bridging = true;
      editor.value = cm.getValue();
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      bridging = false;
    },
    onSelect: () => {
      // only user selections in CM drive the mirror. activeElement containment,
      // not view.hasFocus — the latter is false whenever the WINDOW is unfocused
      if (bridging || !cm.contentDOM.contains(document.activeElement)) return;
      const { start, end } = cm.getSelection();
      try { editor.setSelectionRange(start, end); } catch { /* ignore */ }
      if (state.view === 'split') {
        // CANCEL-and-reschedule, never skip: document-level selectionchange
        // (registered earlier) fires in the same dispatch and always claims
        // mirrorRAF first — gating on it starved the CM mirror on every
        // selection (deterministic, not a race)
        if (mirrorRAF) cancelAnimationFrame(mirrorRAF);
        mirrorRAF = requestAnimationFrame(() => { mirrorRAF = null; highlightFromEditor(); });
      }
    },
    onScroll: () => syncScroll(cm.scroller, previewPane),
  });
  pane.classList.add('cm-on');   // hides the textarea (kept focusable for applyEdit)
  editor.addEventListener('input', () => {   // textarea-side writers → mirror into CM
    if (bridging || editor.value === cm.getValue()) return;
    bridging = true;
    cm.setValueBridged(editor.value);   // undoable in CM (it's an edit, not a load)
    try { cm.setSelection(editor.selectionStart, editor.selectionEnd, { scroll: false }); } catch { /* ignore */ }
    bridging = false;
    if (document.activeElement === editor) cm.focus();   // applyEdit focuses the hidden textarea; come back
  });
  // pasted images / LaTeX offers listen on the textarea — mirror them onto CM's surface
  cm.contentDOM.addEventListener('paste', pasteImage);
  cm.contentDOM.addEventListener('paste', offerLatexPaste);
}

/* toolbar */
q('btnNew').addEventListener('click', newDoc);
q('btnOpen').addEventListener('click', () => fileInput.click());
q('btnSave').addEventListener('click', explicitSave);
q('btnPalette').addEventListener('click', () => { if (!isDialogOpen()) palette.open(); });   // same guard as the keyboard path
q('btnSettings').addEventListener('click', openSettings);
q('btnHistory').addEventListener('click', openHistory);
q('btnNewFromTpl').addEventListener('click', newFromTemplate);
q('btnChooseFolder').addEventListener('click', linkFolder);
q('btnReconnectFolder').addEventListener('click', async () => {
  if (!(await reconnectFolder())) toast('Permission was not granted — the folder stays disconnected', { kind: 'error' });
});
q('projectSelect').addEventListener('change', async () => {
  const sel = q('projectSelect');
  const v = sel.value;
  sel.disabled = true;   // serialize switches — overlapping ones corrupt folderHandle/activeProjectIdx mid-await
  try {
    if (v === 'browser') { await useBrowserLibrary(); return; }
    if (!(await activateProject(+v.slice(1)))) updateLibPath();   // denied/failed → snap the select back
  } finally { sel.disabled = false; }
});
q('libPath').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const items = [{ label: '＋ Add folder…', run: () => linkFolder() }];
  if (folderHandle || pendingFolder) {
    items.push({ sep: true },
      { label: 'Forget this project (files stay on disk)', danger: true, run: () => forgetActiveProject() });
  }
  showContextMenu(e.clientX, e.clientY, 'Projects', items);
});
q('btnFolderRefresh').addEventListener('click', async () => {
  revokeFolderUrls();   // re-resolve every figure — an externally regenerated file must show fresh, and a once-missing one must retry
  await refreshLibrary();
  if (state.currentName) { try { await loadDocByName(state.currentName); } catch { /* ignore */ } }
  scheduleRender();
});
q('viewSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setView(b.dataset.v); });
q('themeSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTheme(b.dataset.t); });
q('styleSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setStyle(b.dataset.s); });
q('layoutSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setLayout(b.dataset.l); });

/* appearance popover (document style / tone / layout / text size) */
const appearanceMenu = q('appearanceMenu');
q('btnAppearance').addEventListener('click', (e) => {
  e.stopPropagation();
  appearanceMenu.hidden = !appearanceMenu.hidden;
  exportMenu.hidden = true;
});
appearanceMenu.addEventListener('click', (e) => e.stopPropagation());   // adjusting several controls keeps it open
const apScale = q('apScale'), apScaleVal = q('apScaleVal');
function reflectScale() { apScale.value = settings.previewScale; apScaleVal.textContent = settings.previewScale + '%'; }
apScale.addEventListener('input', () => {
  updateSetting('previewScale', +apScale.value);
  apScaleVal.textContent = apScale.value + '%';
  applyPreviewScale();
});

/* keep each popover button's aria-expanded in sync however the menu opens or
   closes (button click, document click, Escape, backdrop, sibling mutual-close) */
for (const [menuId, btnId] of [['appearanceMenu', 'btnAppearance'], ['exportMenu', 'btnExport']]) {
  const menuEl = q(menuId), btnEl = q(btnId);
  if (menuEl && btnEl) {
    new MutationObserver(() => btnEl.setAttribute('aria-expanded', String(!menuEl.hidden)))
      .observe(menuEl, { attributes: true, attributeFilter: ['hidden'] });
  }
}

/* export menu */
q('btnExport').addEventListener('click', (e) => { e.stopPropagation(); exportMenu.hidden = !exportMenu.hidden; appearanceMenu.hidden = true; });
exportMenu.addEventListener('click', (e) => {
  const b = e.target.closest('[data-export]'); if (!b) return;
  exportMenu.hidden = true;
  const kind = b.dataset.export;
  if (kind === 'pdf') exportPdf(exportCtx);
  else if (kind === 'html') exportHtml(exportCtx);
  else if (kind === 'word') exportWordCopy(exportCtx);
  else if (kind === 'docx') exportDocx(exportCtx);
  else if (kind === 'md') exportMarkdown(exportCtx);
  else if (kind === 'tex') exportTexSmart();
});

/* library filter */
libSearch.addEventListener('input', renderLib);
q('panelLibrary').addEventListener('contextmenu', (e) => {
  if (e.target.closest('input, .lib-path')) return;   // native menu stays on the search box / path bar
  const assetLi = e.target.closest('li[data-asset]');
  if (assetLi) {   // a figure/PDF in the project tree
    e.preventDefault();
    const path = assetLi.dataset.asset;
    showContextMenu(e.clientX, e.clientY, path, [
      { label: 'View', run: () => openFolderAsset(path) },
      { label: 'Insert into document', run: () => insertAssetRef(path) },
      { sep: true },
      { label: 'Open in new tab', run: () => openFolderDocInTab(path) },
      { label: 'Copy path', run: () => { copyText(folderHandle.name + '/' + path); toast('Copied ' + folderHandle.name + '/' + path); } },
    ]);
    return;
  }
  const li = e.target.closest('li[data-name]');
  e.preventDefault();
  if (!li) {   // blank library space → library-level actions
    showContextMenu(e.clientX, e.clientY, folderHandle ? folderHandle.name : 'Library', [
      { label: 'New document', run: () => newDoc() },
      { label: 'New from template…', run: () => newFromTemplate() },
      { sep: true },
      { label: 'Paste', key: '⌘V', disabled: !libClipboard, run: () => pasteDoc() },
      { sep: true },
      folderHandle
        ? { label: 'Refresh folder', run: () => q('btnFolderRefresh').click() }
        : { label: 'Link a folder…', run: () => linkFolder() },
      ...(folderHandle ? [
        { sep: true },
        { label: 'Forget this project (files stay on disk)', danger: true, run: () => forgetActiveProject() },
      ] : [
        { sep: true },
        { label: 'Save all to disk (.md files)…', run: () => saveAllToDisk() },
      ]),
    ]);
    return;
  }
  li.focus();   // shortcuts now target this item too
  const name = li.dataset.name;
  showContextMenu(e.clientX, e.clientY, name, [
    { label: 'Open', key: '⏎', run: () => loadDocByName(name) },
    { sep: true },
    { label: 'Rename…', run: () => renameDoc(name) },
    { label: 'Duplicate', key: '⌘D', run: () => duplicateDoc(name) },
    { sep: true },
    { label: 'Copy', key: '⌘C', run: () => copyDoc(name) },
    { label: 'Paste', key: '⌘V', disabled: !libClipboard, run: () => pasteDoc() },
    // the browser can't reveal a linked folder's absolute path — folder/file is all it knows
    { label: folderHandle ? 'Copy path' : 'Copy name', run: () => {
      copyText(folderHandle ? folderHandle.name + '/' + name : name);
      toast('Copied ' + (folderHandle ? folderHandle.name + '/' + name : name));
    } },
    { sep: true },
    ...(folderHandle ? [
      { label: 'Open file in new tab', run: () => openFolderDocInTab(name) },
    ] : [
      { label: 'Save to disk', run: () => saveDocToDisk(name) },
      { label: 'Where is this file?', run: () => whereIsDoc(name) },
    ]),
    { sep: true },
    { label: 'Delete', key: '⌘⌫', danger: true, run: () => deleteDoc(name) },
  ]);
});

/* library keyboard shortcuts — act on the focused item (items are focusable;
   click and right-click both focus). Scoped to the list so the editor's own
   ⌘C/⌘V are untouched. */
libListEl.addEventListener('keydown', (e) => {
  const items = [...libListEl.querySelectorAll('li[data-name], li[data-asset], li.lib-dir')];
  if (!items.length) return;
  const focused = document.activeElement && document.activeElement.closest
    ? document.activeElement.closest('li[data-name], li[data-asset], li.lib-dir') : null;
  const name = focused && focused.dataset ? focused.dataset.name : null;
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const idx = items.indexOf(focused);
    const next = idx === -1 ? items[0]
      : items[Math.min(items.length - 1, Math.max(0, idx + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) next.focus();
  } else if (e.key === 'Enter' && name) { e.preventDefault(); loadDocByName(name); }
  else if (e.key === 'Enter' && focused && focused.dataset.asset) { e.preventDefault(); openFolderAsset(focused.dataset.asset); }
  else if (mod && key === 'c' && name) { e.preventDefault(); copyDoc(name); }
  else if (mod && key === 'v') { e.preventDefault(); pasteDoc(); }
  else if (mod && key === 'd' && name) { e.preventDefault(); duplicateDoc(name); }
  else if (mod && e.key === 'Backspace' && name) { e.preventDefault(); deleteDoc(name); }
});

/* preview: right-click a reference entry → attach/open/remove its PDF */
preview.addEventListener('contextmenu', (e) => {
  // right-click a figure → see where it lives on disk and open it
  const img = e.target.closest('img');
  if (img) {
    e.preventDefault();
    const raw = img.getAttribute('src') || '';
    const abs = raw ? (() => { try { return new URL(raw, location.href).href; } catch { return raw; } })() : '';
    const onDisk = abs.startsWith('file:');
    const embedded = abs.startsWith('blob:') || abs.startsWith('data:');
    const shown = onDisk ? decodeURIComponent(abs.replace(/^file:\/\//, '')) : abs;
    const items = [];
    if (abs) items.push({ label: 'Open image in new tab', run: () => { try { window.open(abs, '_blank'); } catch { /* ignore */ } } });
    const local = img.getAttribute('data-local-src');   // a project file resolved to blob: — IS on disk
    if (local) {
      const p = (() => { try { return decodeURIComponent(local); } catch { return local; } })();
      items.push({ label: 'Copy path', run: () => { copyText(folderHandle ? folderHandle.name + '/' + p : p); toast('Copied ' + (folderHandle ? folderHandle.name + '/' + p : p)); } });
    } else if (embedded) items.push({ label: 'Embedded in the document (no file on disk)', disabled: true });
    else if (abs) items.push({ label: onDisk ? 'Copy file path' : 'Copy image URL', run: () => { copyText(shown); toast(onDisk ? 'File path copied' : 'Image URL copied'); } });
    if (!items.length) items.push({ label: 'No source for this image', disabled: true });
    // the figure's own markdown: jump to it, or delete it — the preview side
    // is where figures are SEEN, so removal must work from here too
    const holder = img.closest('[data-src-start]');
    if (holder && !isTexDoc()) {
      items.push({ sep: true },
        { label: 'Reveal in editor', run: () => { if (state.view === 'preview') setView('split'); editorJumpToLine(+holder.dataset.srcStart, +holder.dataset.srcEnd); } },
        { label: 'Remove figure', danger: true, run: () => removeSourceBlock(+holder.dataset.srcStart, +holder.dataset.srcEnd) });
    }
    showContextMenu(e.clientX, e.clientY, embedded ? 'Image' : shown, items);
    return;
  }
  const li = e.target.closest('.references li[id^="ref-"]');
  if (!li) return;                       // everywhere else keeps the native menu
  e.preventDefault();
  const key = li.id.slice(4);
  showContextMenu(e.clientX, e.clientY, '@' + key, refPdfs.has(key) ? [
    { label: 'Open PDF', run: () => openRefPdf(key) },
    { label: 'Replace PDF…', run: () => attachRefPdf(key) },
    { sep: true },
    { label: 'Remove PDF', danger: true, run: () => removeRefPdf(key) },
  ] : [
    { label: 'Attach PDF…', run: () => attachRefPdf(key) },
  ]);
});

/* preview: ⌥-click any block → jump the editor caret to its source line
   (the research pass found this preview→editor direction is an unmet request
   even in VS Code's most popular markdown extension; selecting text in the
   preview already mirrors, this covers the caret-only click). */
preview.addEventListener('click', (e) => {
  if (!e.altKey) return;
  const el = e.target.closest('[data-src-start]');
  if (!el) return;
  e.preventDefault();
  const line = +el.dataset.srcStart;
  const off = offsetOfLine(editor.value, line);
  try { editor.setSelectionRange(off, off); } catch { /* ignore */ }
  if (cm) cm.setSelection(off, off, { scroll: false });
  setEditorHighlight(line, +el.dataset.srcEnd);
  withScrollLock(() => revealEditorLine(line));
  focusEditor();
});

/* preview: code-copy + internal anchors */
preview.addEventListener('click', (e) => {
  const copyBtn = e.target.closest('[data-copy]');
  if (copyBtn) {
    const code = copyBtn.closest('.code-wrap')?.querySelector('code');
    if (code) {
      copyText(code.textContent.replace(/\n$/, ''));
      const old = copyBtn.textContent; copyBtn.textContent = 'copied ✓';
      setTimeout(() => { copyBtn.textContent = old; }, 1200);
    }
    return;
  }
  const a = e.target.closest('a[href^="#"]');
  if (a) { const id = decodeURIComponent(a.getAttribute('href').slice(1)); if (id) { e.preventDefault(); scrollToHeading(id); } return; }
  // a relative .pdf link → the in-app PDF viewer. The sanitizer stashes the
  // relative href as inert data-local-href (like data-local-src for images);
  // this is the ONLY code that acts on it. The browser sandbox cannot open
  // the OS-default app — see openAssetViewer.
  const pl = e.target.closest('a[data-local-href]');
  if (pl && !e.altKey) {   // ⌥-click keeps the source-mapping gesture, like images
    let href = pl.getAttribute('data-local-href') || '';
    try { href = decodeURIComponent(href); } catch { /* keep raw */ }
    if (/\.pdf$/i.test(href) && isFolderRelativeSrc(href)) {
      e.preventDefault();
      if (folderHandle) openAssetViewer(href, folderReadFile(href), { copyPath: true });
      else openAssetViewer(href, fetch(href).then((r) => { if (!r.ok) throw new Error(r.status); return r.blob(); }));
      return;
    }
  }
  // click a rendered figure → zoom it in the viewer (alt-click still maps to
  // source; images inside links keep their link behavior)
  const pimg = e.target.closest('img');
  if (pimg && !e.altKey && !pimg.closest('a') && pimg.currentSrc) {
    openAssetViewer(pimg.getAttribute('data-local-src') || pimg.getAttribute('alt') || 'figure',
      { url: pimg.currentSrc }, { kind: 'image' });
  }
});

/* splitter drag */
let dragging = false;
splitter.addEventListener('pointerdown', (e) => {
  dragging = true; splitter.classList.add('drag');
  try { splitter.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  e.preventDefault();   // fast drags must not start text selection / native drag
});
// the read pane never goes below a full Letter sheet (816px); the editor keeps
// 320px. Enforced at ALL times via clampSplit (not only while dragging), so the
// pane never rests below the minimum and there's no jump on first drag.
const MIN_EDITOR_PX = 320, MIN_PREVIEW_PX = 816;
function clampSplit() {
  const r = main.getBoundingClientRect();
  if (!r.width) return;
  const sidebarW = main.classList.contains('with-sidebar') ? 270 : 0;
  const avail = r.width - sidebarW - 1;
  const cur = parseFloat(getComputedStyle(root).getPropertyValue('--split')) || 50;
  let editorPx = cur / 100 * r.width;
  const hi = Math.max(MIN_EDITOR_PX, avail - MIN_PREVIEW_PX);   // preview keeps >= 816 when the window allows
  editorPx = Math.max(MIN_EDITOR_PX, Math.min(hi, editorPx));
  root.style.setProperty('--split', (editorPx / r.width * 100) + '%');
}
splitter.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const r = main.getBoundingClientRect();
  const sidebarW = main.classList.contains('with-sidebar') ? 270 : 0;
  const avail = r.width - sidebarW - 1;            // room for editor + preview (splitter is 1px)
  let editorPx = e.clientX - r.left - sidebarW;
  // clamp so neither pane collapses; the read pane in particular keeps MIN_PREVIEW_PX
  const hi = Math.max(MIN_EDITOR_PX, avail - MIN_PREVIEW_PX);
  editorPx = Math.max(MIN_EDITOR_PX, Math.min(hi, editorPx));
  root.style.setProperty('--split', (editorPx / r.width * 100) + '%');
});
/* End the drag on EVERY release path — a fast drag can outrun pointer capture
   (capture loss, release outside the window, app losing focus), which used to
   leave the splitter stuck in dragging state until another click. */
const endSplitDrag = () => { if (!dragging) return; dragging = false; splitter.classList.remove('drag'); updatePageBreaks(); markSyncMapDirty(); };
splitter.addEventListener('pointerup', endSplitDrag);
splitter.addEventListener('pointercancel', endSplitDrag);
splitter.addEventListener('lostpointercapture', endSplitDrag);
window.addEventListener('pointerup', endSplitDrag);
window.addEventListener('blur', endSplitDrag);

/* scroll sync + heading spy — block-anchored, toggle-gated.
   Every rendered block already knows its source lines (data-src-start, the
   selection-mirror tags), so instead of a pure position ratio — which drifts
   the moment one source line renders as a tall image/equation/diagram — the
   panes are aligned through a piecewise-linear map built from real pixel
   anchor pairs (source-line top in the editor ↔ block top in the preview).
   Ratio sync remains the fallback when no tags exist (.tex live preview). */
let scrollLock = false, lockGen = 0, spyRAF = null;
/* Anti-echo, by EXPECTED VALUE rather than a time window. Setting
   `to.scrollTop = X` fires a scroll event on `to`; if its handler runs sync
   again it maps straight back and the panes chase each other (the maps aren't
   exact inverses, so the echo visibly moves them; worst case it resurrects the
   "selects a ton" preview-drag loop).

   An earlier fix time-locked for two frames — correct, but it DROPPED every
   source scroll event during the lock, so the mirror pane updated at ~30fps
   and felt laggy (user-reported). Instead: remember the exact scrollTop we
   just wrote to each pane; when that pane's echo arrives matching that value,
   consume it and stop. A real user scroll of the other pane won't match, so
   the source pane keeps driving at the full frame rate — no dropped events,
   no lag — and this needs no rAF, so it also holds in occluded tabs. */
const expectEcho = new WeakMap();   // scroller → the scrollTop we programmatically set
function scrollTo(pane, top) {
  const clamped = Math.round(top);
  pane.scrollTop = clamped;
  expectEcho.set(pane, pane.scrollTop);   // read back the landed value (clamp/subpixel)
}
function isEcho(pane) {
  if (!expectEcho.has(pane)) return false;
  const exp = expectEcho.get(pane);
  expectEcho.delete(pane);                // one echo per programmatic write
  return Math.abs(pane.scrollTop - exp) <= 2;
}
/* withScrollLock still needs a HARD lock: the preview-drag reveal scrolls the
   editor independently (not a sync echo), and that scroll must be fully
   ignored, not value-matched. Kept as a brief generation-token lock. */
function acquireScrollLock() {
  scrollLock = true;
  const g = ++lockGen;
  const release = () => { if (lockGen === g) scrollLock = false; };
  requestAnimationFrame(() => requestAnimationFrame(release));
  setTimeout(release, 250);              // occluded-tab fallback (rAF starves)
}
let scrollSyncOn = true;
let syncCache = null;                        // {eH, pH, e2p, p2e} — heights it was built at
function markSyncMapDirty() { syncCache = null; }
function buildSyncAnchors() {
  const els = [...preview.querySelectorAll('[data-src-start]')];
  if (els.length < 2) return null;
  let tops;
  try { tops = measureEditorLineTops(els.map((el) => +el.dataset.srcStart)); } catch { return null; }
  const paneTop = previewPane.getBoundingClientRect().top;
  const base = previewPane.scrollTop;
  return els.map((el, i) => ({ from: tops[i], to: el.getBoundingClientRect().top - paneTop + base }));
}
function getSyncMaps() {
  const ed = cm ? cm.scroller : editor;
  const eH = ed.scrollHeight, pH = previewPane.scrollHeight;
  // heights changing under the cache (async images/mermaid/fonts, typing)
  // invalidate it without every load path having to remember to tell us
  if (!syncCache || Math.abs(syncCache.eH - eH) > 4 || Math.abs(syncCache.pH - pH) > 4) {
    const pairs = buildSyncAnchors();
    syncCache = {
      eH, pH,
      e2p: pairs ? buildScrollMap(pairs, eH, pH) : null,
      p2e: pairs ? buildScrollMap(pairs.map((p) => ({ from: p.to, to: p.from })), pH, eH) : null,
    };
  }
  return syncCache;
}
try { scrollSyncOn = localStorage.getItem('colophon-scrollsync') !== '0'; } catch { /* ignore */ }
function setScrollSync(on) {
  scrollSyncOn = on;
  try { lsSet('colophon-scrollsync', on ? '1' : '0'); } catch { /* ignore */ }
  const btn = q('btnScrollSync');
  if (btn) { btn.classList.toggle('active', on); btn.setAttribute('aria-pressed', String(on)); }
}
function syncScroll(from, to) {
  if (scrollLock || !scrollSyncOn || state.view !== 'split') return;
  if (isEcho(from)) return;                                // this scroll is our own programmatic write
  const fromMax = from.scrollHeight - from.clientHeight;
  if (fromMax < 2) return;                                 // source pane has nothing to scroll
  const af = SYNC_ANCHOR[settings.scrollAnchor] ?? 0;
  const toMax = Math.max(0, to.scrollHeight - to.clientHeight);
  const maps = getSyncMaps();
  const map = from === previewPane ? maps.p2e : maps.e2p;
  let target;
  if (map) {
    // block-anchored: map the chosen viewport line through the anchor table
    target = mapScroll(map, from.scrollTop + af * from.clientHeight) - af * to.clientHeight;
  } else {
    // fallback (no block tags, e.g. .tex live preview): proportional
    const refFrac = (from.scrollTop + af * from.clientHeight) / (from.scrollHeight || 1);
    target = refFrac * to.scrollHeight - af * to.clientHeight;
  }
  // blend toward a straight range mapping near the ends, so the panes meet
  // exactly at top/top and bottom/bottom whatever the anchor choice
  const fr = Math.min(1, Math.max(0, from.scrollTop / fromMax));
  const z = 0.08;                                          // edge blend zone (fraction of range)
  const wEdge = fr < z ? 1 - fr / z : fr > 1 - z ? (fr - (1 - z)) / z : 0;
  scrollTo(to, Math.min(toMax, Math.max(0, target * (1 - wEdge) + fr * toMax * wEdge)));
}
// In CM mode the textarea is parked off-screen but still SCROLLS when applyEdit
// focuses it (toolbar edits, find) — its scrollTop is meaningless
// in cm-scroller map space, so never let it drive sync; CM's own scroll does.
editor.addEventListener('scroll', () => { if (!cm) syncScroll(editor, previewPane); });
previewPane.addEventListener('scroll', () => {
  syncScroll(previewPane, cm ? cm.scroller : editor);
  if (!spyRAF) spyRAF = requestAnimationFrame(() => { spyRAF = null; updateCurrentHeading(); });
});
q('btnScrollSync').addEventListener('click', () => setScrollSync(!scrollSyncOn));
setScrollSync(scrollSyncOn);   // reflect persisted state on the button at boot

/* drag-and-drop import */
window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drag-hot'); });
window.addEventListener('dragleave', (e) => { if (e.relatedTarget === null) document.body.classList.remove('drag-hot'); });
window.addEventListener('drop', async (e) => {
  e.preventDefault(); document.body.classList.remove('drag-hot');
  const files = e.dataTransfer && e.dataTransfer.files;
  if (files && files.length) await addFiles(files);
});
fileInput.addEventListener('change', async (e) => { const files = e.target.files; if (files && files.length) await addFiles(files); fileInput.value = ''; });
q('imgInput').addEventListener('change', (e) => { const files = e.target.files; if (files && files.length) insertImagesFromFiles(files); e.target.value = ''; });

/* dismiss palette/menu on backdrop click + global Esc */
q('backdrop').addEventListener('click', () => { palette.close(); closeDialog(); exportMenu.hidden = true; appearanceMenu.hidden = true; });
q('dialogClose').addEventListener('click', () => closeDialog());   // the × in the dialog header
document.addEventListener('click', () => {
  if (!exportMenu.hidden) exportMenu.hidden = true;
  if (!appearanceMenu.hidden) appearanceMenu.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!exportMenu.hidden) exportMenu.hidden = true;
  if (!appearanceMenu.hidden) appearanceMenu.hidden = true;
});

/* chrome auto-follow */
if (window.matchMedia) {
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const onMq = () => { if (state.chromeMode === 'auto') applyChrome(); };
  if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq);
}

/* autosave flush on the way out */
window.addEventListener('pagehide', () => { flushDraft(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) flushDraft(); });
window.addEventListener('beforeunload', () => { if (state.dirty) flushDraft(); });

/* ---------- in-page selftest (headless CI: ?selftest=1) ----------
   Renders fixtures through the full pipeline into a hidden container, roundtrips
   the store, then replaces the body with a human-readable PASS/FAIL report. The
   sync checks paint immediately so a headless screenshot captures the report even
   while the async store checks resolve. */
window.__colophonSelftest = async function () {
  initSanitizer(window);
  const results = [];
  const box = document.createElement('div');
  box.style.display = 'none';
  document.body.appendChild(box);
  const chk = (name, pass) => { results.push('SELFTEST: ' + (pass ? 'PASS' : 'FAIL') + ' — ' + name); };
  const paint = (final) => {
    const pass = results.length && results.every((l) => l.startsWith('SELFTEST: PASS'));
    document.title = final ? (pass ? 'SELFTEST PASS' : 'SELFTEST FAIL') : 'SELFTEST RUNNING';
    const head = final ? (pass ? 'SELFTEST PASS' : 'SELFTEST FAIL') : 'SELFTEST RUNNING…';
    const pre = document.createElement('pre');
    pre.style.cssText = 'font:16px/1.8 ui-monospace,Menlo,Consolas,monospace;padding:32px;white-space:pre-wrap;color:#111;background:#fff;min-height:100vh;margin:0;';
    pre.textContent = head + '\n\n' + results.join('\n');
    document.body.replaceChildren(pre);
  };
  try {
    box.innerHTML = render('$x^2$', {}).html;            // sanitized pipeline output → hidden container
    chk('inline math renders KaTeX', /katex/.test(box.innerHTML));
    box.innerHTML = render('<img src=x onerror=alert(1)>', {}).html;
    chk('XSS onerror stripped', !/onerror/i.test(box.innerHTML));
    box.innerHTML = render('```python\nimport numpy as np\n```', {}).html;
    chk('python fence highlighted (hljs)', /hljs/.test(box.innerHTML));
    paint(false);                                        // sync results are visible now
    // Drive the store through its in-memory backend for the roundtrip checks: it
    // resolves via microtasks (before the load-event paint), so the headless CI
    // screenshot is deterministic. Real IndexedDB is covered by the store unit tests.
    _injectIDB({ open() { throw new Error('selftest: forced in-memory backend'); } });
    await docPut('__selftest__.md', 'hello-roundtrip');
    const g = await docGet('__selftest__.md');
    chk('store doc roundtrip', !!g && g.content === 'hello-roundtrip');
    await docDelete('__selftest__.md');
    await draftPut('__selftest__.md', 'draft-roundtrip');
    const d = await draftGet('__selftest__.md');
    chk('draft roundtrip', !!d && d.content === 'draft-roundtrip');
    await draftClear('__selftest__.md');
  } catch (e) { chk('unexpected exception: ' + ((e && e.message) || e), false); }
  const pass = results.every((l) => l.startsWith('SELFTEST: PASS'));
  try { console.log((pass ? 'SELFTEST PASS' : 'SELFTEST FAIL') + '\n' + results.join('\n')); } catch { /* ignore */ }
  paint(true);
  return pass;
};

/* ---------- boot ---------- */
/* Upgrade UNEDITED seed docs to their current text (and migrate renamed ones).
   A seed doc counts as unedited only if its stored content hash matches a
   superseded seed version AND it has no diverging draft — anything the user
   touched is left strictly alone. */
async function refreshSeeds() {
  if (folderHandle) return;                         // never rewrite files on disk
  for (const s of SEED_DOCS) {
    // a seed that never existed here is created ONCE (the flag makes a user's
    // deletion of it stick instead of resurrecting every boot)
    try {
      const flagKey = 'colophon-seeded:' + s.name;
      let flagged = false; try { flagged = !!localStorage.getItem(flagKey); } catch { /* ignore */ }
      const anyExisting = (await docGet(s.name)) || (await Promise.all(s.oldNames.map((n) => docGet(n)))).some(Boolean);
      if (!anyExisting && !flagged) await docPut(s.name, s.content);
      lsSet(flagKey, '1');
    } catch { /* ignore */ }
    for (const nm of [s.name, ...s.oldNames]) {
      try {
        const d = await docGet(nm);
        if (!d || typeof d.content !== 'string') continue;
        if (!s.oldHashes.includes(seedHash(d.content))) continue;   // current, or user-edited
        const draft = await draftGet(nm);
        if (draft && draft.content != null && draft.content !== d.content) continue;
        if (nm !== s.name) { await docDelete(nm); await draftClear(nm); }
        await docPut(s.name, s.content);
        await draftClear(s.name);
        if (state.currentName === nm) state.currentName = s.name;
        try { if (localStorage.getItem('colophon-last') === nm) lsSet('colophon-last', s.name); } catch { /* ignore */ }
      } catch { /* ignore */ }
    }
  }
}
/* Seed showcase assets (the Welcome figure) into the asset store — both
   storage modes read assets from IndexedDB. Create-once, like seed docs. */
async function ensureSeedAssets() {
  for (const a of SEED_ASSETS) {
    try {
      const flagKey = 'colophon-seeded-asset:' + a.id;
      if (await assetGet(a.id)) { lsSet(flagKey, '1'); continue; }
      let flagged = false; try { flagged = !!localStorage.getItem(flagKey); } catch { /* ignore */ }
      if (flagged) continue;                        // was collected after its references went away — stays gone
      await assetPut(a.id, new Blob([a.content], { type: a.mime }), a.mime);
      lsSet(flagKey, '1');
    } catch { /* ignore */ }
  }
}
async function firstRunOrOpen() {
  const all = folderHandle ? await folderList() : await docsAll();
  if (storageMode() === 'memory') toast('Storage unavailable — documents live only for this session', { timeout: 0 });
  let visited = false; try { visited = !!localStorage.getItem('colophon-visited'); } catch { /* ignore */ }
  if (!folderHandle && all.length === 0 && !visited) {
    // Folder-first: on a genuinely fresh start, ask where documents should
    // live before anything is stored. Hosts without the folder API (file://,
    // non-Chromium, sandboxes) go straight to in-app storage.
    if (folderSupported() && !pendingFolder) {
      const choice = await offerFolderFirstRun();
      lsSet('colophon-visited', '1');
      if (choice === 'folder') return;              // linked, seeded, and opened inside the dialog flow
    }
    for (const s of SEED_DOCS) {
      try { await docPut(s.name, s.content); lsSet('colophon-seeded:' + s.name, '1'); } catch { /* ignore */ }
    }
    lsSet('colophon-visited', '1');
    await refreshLibrary();
    await loadDocByName('Welcome.md');
    return;
  }
  await refreshSeeds();
  lsSet('colophon-visited', '1');
  let last = null; try { last = localStorage.getItem('colophon-last'); } catch { /* ignore */ }
  await refreshLibrary();
  const names = docsCache.map((d) => d.name);
  const target = (last && names.includes(last)) ? last : (docsCache[0] && docsCache[0].name);
  if (target) await loadDocByName(target);
  else { try { await writeNewDoc('Welcome.md', WELCOME_MD); } catch { /* ignore */ } await refreshLibrary(); await loadDocByName('Welcome.md'); }
  // The §5 M-flow entry: launched over http with in-app documents and no
  // folder — offer the move ONCE (linking a folder re-offers contextually)
  let nudged = false; try { nudged = !!localStorage.getItem('colophon-migrate-nudged'); } catch { /* ignore */ }
  if (!folderHandle && folderSupported() && docsCache.length && !nudged && !legacyInfo()) {
    lsSet('colophon-migrate-nudged', '1');
    toast('Your documents live in browser storage. Move them into a real folder on disk — copies, nothing deleted?', {
      actionLabel: 'Choose folder…',
      onAction: () => linkFolder(),
      timeout: 14000,
    });
  }
}

async function boot() {
  initSanitizer(window);
  // Selftest short-circuits before any other async boot step so its synchronous
  // checks paint the report before the load event (headless-screenshot friendly).
  if (new URLSearchParams(location.search).has('selftest')) { await window.__colophonSelftest(); return; }
  loadSettings();
  applySettings();
  applyChrome();
  applyPreviewClass();
  previewPane.style.background = THEME_BG[state.theme] || '#fff';
  setView(state.view);
  markSeg('themeSeg', 't', state.theme);
  markSeg('styleSeg', 's', state.docStyle);
  markSeg('layoutSeg', 'l', settings.readingLayout);
  if (window.innerWidth < 760) setView('preview');
  const folderState = await restoreFolder();
  await loadProjects();
  try { browserDocsExist = (await docsAll()).length > 0; } catch { /* ignore */ }
  updateLibPath();
  await ensureSeedAssets();
  try { refPdfs = new Set((await metaGet('refpdfs')) || []); } catch { /* ignore */ }
  // A stored folder that needs re-permission: ask up front, THEN open — the
  // in-browser library must not flash seeded starter docs at a folder user.
  if (folderState === 'prompt') await offerReconnect();
  if (folderHandle) {   // reconnected inside the dialog — library is already open
    if (!state.currentName || !hasLoaded) await firstRunOrOpen();
    return;
  }
  await firstRunOrOpen();
}

/* Boot now if the DOM is already parsed (normal single-file build AND the artifact
   body-fragment, where this script is injected after the app markup); otherwise
   wait for DOMContentLoaded. Never blocks on the load event. */
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', boot);
else Promise.resolve().then(boot);
