/* Command registry, keyboard-shortcut binding, and the command palette.
   Commands are plain data ({id,title,cat,keys,run,when?}); run/when close over the
   ctx supplied by main and are only invoked at trigger time, so the registry can be
   built with a stub ctx in tests. Text-formatting commands edit the textarea while
   preserving its native undo stack (via ui.applyEdit). */

import { applyEdit, showBackdrop } from './ui.js';

const IS_MAC = typeof navigator !== 'undefined'
  && /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent || '');

/* ---------- key specs ---------- */
export function parseKeySpec(spec) {
  if (typeof spec !== 'string' || !spec.trim()) return null;
  const parts = spec.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const out = { mod: false, ctrl: false, meta: false, alt: false, shift: false, key: '' };
  for (const p of parts.slice(0, -1)) {
    switch (p.toLowerCase()) {
      case 'mod': out.mod = true; break;
      case 'ctrl': case 'control': out.ctrl = true; break;
      case 'cmd': case 'meta': case 'command': out.meta = true; break;
      case 'alt': case 'option': out.alt = true; break;
      case 'shift': out.shift = true; break;
      default: return null;
    }
  }
  out.key = parts[parts.length - 1].toLowerCase();
  return out.key ? out : null;
}

/* physical-key fallback for the spec key ('v' → 'KeyV', '1' → 'Digit1').
   With Alt/Option held, macOS layouts deliver a COMPOSED character in e.key
   (⌥V → '√', ⌥N → 'Dead'), so an Alt binding would never match on e.key
   alone. e.code is the layout-independent physical key — the same fallback
   CodeMirror/VS Code use for Alt combos. */
function codeFor(key) {
  if (/^[a-z]$/.test(key)) return 'Key' + key.toUpperCase();
  if (/^[0-9]$/.test(key)) return 'Digit' + key;
  return null;
}
export function matchesEvent(e, ks) {
  const wantCtrl = ks.ctrl || (ks.mod && !IS_MAC);
  const wantMeta = ks.meta || (ks.mod && IS_MAC);
  if (!!e.ctrlKey !== !!wantCtrl) return false;
  if (!!e.metaKey !== !!wantMeta) return false;
  if (!!e.altKey !== !!ks.alt) return false;
  if (ks.shift && !e.shiftKey) return false;
  // symbol keys (e.g. ?) require Shift on many layouts — only forbid stray Shift for letters/digits
  if (!ks.shift && e.shiftKey && /^[a-z0-9]$/.test(ks.key)) return false;
  if ((e.key || '').toLowerCase() === ks.key) return true;
  // Alt held → e.key is a composed glyph; fall back to the physical key
  return ks.alt && !!e.code && e.code === codeFor(ks.key);
}

export function prettyKeys(spec) {
  const ks = parseKeySpec(spec);
  if (!ks) return spec;
  const parts = [];
  if (ks.mod) parts.push(IS_MAC ? '⌘' : 'Ctrl');
  if (ks.ctrl) parts.push('Ctrl');
  if (ks.meta && !ks.mod) parts.push('⌘');
  if (ks.alt) parts.push(IS_MAC ? '⌥' : 'Alt');
  if (ks.shift) parts.push(IS_MAC ? '⇧' : 'Shift');
  let key = ks.key.length === 1 ? ks.key.toUpperCase() : ks.key.replace(/^f(\d+)$/, 'F$1');
  parts.push(key);
  return IS_MAC ? parts.join('') : parts.join('+');
}

/* ---------- fuzzy subsequence matcher ---------- */
export function fuzzyMatch(query, target) {
  if (!query) return 0;
  const q = query.toLowerCase(), t = String(target).toLowerCase();
  let qi = 0, score = 0, prev = -2;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += (ti === prev + 1) ? 3 : 1;      // contiguous run bonus
      if (ti === 0) score += 3;                // start-of-string bonus
      else if (/[\s:_\-/]/.test(t[ti - 1])) score += 2;  // word-boundary bonus
      prev = ti; qi++;
    }
  }
  return qi === q.length ? score : -1;
}

/* ---------- textarea formatting (undo-preserving) ---------- */
function wrapSelection(el, before, after, placeholder) {
  if (!el || el.selectionStart == null) return;
  el.focus();
  const s = el.selectionStart, e = el.selectionEnd;
  const inner = el.value.slice(s, e) || placeholder || '';
  applyEdit(el, s, e, before + inner + after, [s + before.length, s + before.length + inner.length]);
}
function insertLink(el) {
  if (!el || el.selectionStart == null) return;
  el.focus();
  const s = el.selectionStart, e = el.selectionEnd;
  const text = el.value.slice(s, e) || 'text';
  const md = '[' + text + '](url)';
  const urlStart = s + text.length + 3;        // "[" + text + "](" → start of url placeholder
  applyEdit(el, s, e, md, [urlStart, urlStart + 3]);
}

/* ---------- registry ---------- */
export function createCommands(ctx) {
  // ctx.isEditorFocused lets the host widen "the editor" beyond the textarea
  // (the flagged CodeMirror surface counts too — see main.js)
  const isEditor = () => typeof document !== 'undefined'
    && (ctx.isEditorFocused ? ctx.isEditorFocused() : document.activeElement === ctx.editor);
  const notTyping = () => {
    if (typeof document === 'undefined') return true;
    const a = document.activeElement;
    return !a || !a.matches || !a.matches('input, textarea, [contenteditable]');
  };
  const fmt = (b, a, ph) => () => wrapSelection(ctx.editor, b, a, ph);
  return [
    { id: 'save', title: 'Save document', cat: 'File', keys: ['Mod+S'], run: () => ctx.save() },
    { id: 'palette', title: 'Command palette', cat: 'App', keys: ['Mod+K'], run: () => ctx.openPalette() },
    { id: 'quick-open', title: 'Quick open document', cat: 'File', keys: ['Mod+P'], run: () => ctx.openPalette({ mode: 'docs' }) },
    { id: 'find', title: 'Find and replace', cat: 'Edit', keys: ['Mod+F'], run: () => ctx.openFind() },
    { id: 'new', title: 'New document', cat: 'File', keys: ['Mod+Alt+N'], run: () => ctx.newDoc() },
    { id: 'new-template', title: 'New from template…', cat: 'File', keys: [], run: () => ctx.newFromTemplate() },
    { id: 'open-file', title: 'Open file…', cat: 'File', keys: [], run: () => ctx.openFile() },
    { id: 'rename', title: 'Rename document', cat: 'File', keys: ['F2'], run: () => ctx.rename() },
    { id: 'duplicate', title: 'Duplicate document', cat: 'File', keys: [], run: () => ctx.duplicate() },
    { id: 'delete', title: 'Delete document', cat: 'File', keys: [], run: () => ctx.deleteDoc() },
    { id: 'history', title: 'Version history', cat: 'File', keys: [], run: () => ctx.openHistory() },
    { id: 'link-folder', title: 'Link folder on disk…', cat: 'File', keys: [], run: () => ctx.linkFolder() },
    { id: 'bold', title: 'Bold', cat: 'Format', keys: ['Mod+B'], when: isEditor, run: fmt('**', '**', 'bold text') },
    { id: 'italic', title: 'Italic', cat: 'Format', keys: ['Mod+I'], when: isEditor, run: fmt('*', '*', 'italic text') },
    { id: 'code', title: 'Inline code', cat: 'Format', keys: ['Mod+E'], when: isEditor, run: fmt('`', '`', 'code') },
    { id: 'link', title: 'Insert link', cat: 'Format', keys: ['Mod+Shift+K'], when: isEditor, run: () => insertLink(ctx.editor) },
    { id: 'insert-figure', title: 'Insert figure…', cat: 'Format', keys: ['Mod+Shift+I'], run: () => ctx.insertFigure() },
    { id: 'view-split', title: 'View: Split', cat: 'View', keys: ['Mod+Alt+1'], run: () => ctx.setView('split') },
    { id: 'view-editor', title: 'View: Write', cat: 'View', keys: ['Mod+Alt+2'], run: () => ctx.setView('editor') },
    { id: 'view-preview', title: 'View: Read', cat: 'View', keys: ['Mod+Alt+3'], run: () => ctx.setView('preview') },
    { id: 'sidebar', title: 'Toggle sidebar', cat: 'View', keys: ['Mod+\\'], run: () => ctx.toggleSidebar() },
    { id: 'latex-import', title: 'Convert LaTeX to Markdown', cat: 'Edit', keys: [], run: () => ctx.latexImport() },
    { id: 'cheatsheet', title: 'Keyboard shortcuts', cat: 'App', keys: ['?'], when: notTyping, run: () => ctx.openCheatsheet() },
    { id: 'settings', title: 'Settings', cat: 'App', keys: [], run: () => ctx.openSettings() },
    { id: 'export-pdf', title: 'Export: PDF', cat: 'Export', keys: [], run: () => ctx.exportPdf() },
    { id: 'export-html', title: 'Export: HTML', cat: 'Export', keys: [], run: () => ctx.exportHtml() },
    { id: 'export-word', title: 'Export: Copy for Word', cat: 'Export', keys: [], run: () => ctx.exportWordCopy() },
    { id: 'export-md', title: 'Export: Markdown', cat: 'Export', keys: [], run: () => ctx.exportMarkdown() },
  ];
}

/* ---------- global shortcut binding ---------- */
export function bindShortcuts(commands, ctx, opts = {}) {
  const isBlocked = opts.isBlocked || (() => false);
  const handler = (e) => {
    if (isBlocked()) return;
    for (const cmd of commands) {
      if (!cmd.keys) continue;
      for (const spec of cmd.keys) {
        const ks = parseKeySpec(spec);
        if (!ks || !matchesEvent(e, ks)) continue;
        if (cmd.when && !cmd.when()) continue;   // matched combo but context forbids → let default happen
        e.preventDefault();
        cmd.run();
        return;
      }
    }
  };
  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}

/* ---------- command palette ---------- */
/* matched character positions in target (for highlighting), or null if no match */
export function matchPositions(query, target) {
  if (!query) return null;
  const q = query.toLowerCase(), t = String(target).toLowerCase();
  const pos = []; let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) { if (t[ti] === q[qi]) { pos.push(ti); qi++; } }
  return qi === q.length ? pos : null;
}

export function createPalette(commands, ctx) {
  const pal = document.getElementById('palette');
  const input = document.getElementById('paletteInput');
  const list = document.getElementById('paletteList');
  let items = [], sel = 0, open = false;

  // most-recently-used commands float to the top of the empty palette
  let recents = [];
  try { recents = JSON.parse(localStorage.getItem('colophon-cmd-recents') || '[]') || []; } catch { /* ignore */ }
  function recordUse(title) {
    recents = [title, ...recents.filter((t) => t !== title)].slice(0, 8);
    try { localStorage.setItem('colophon-cmd-recents', JSON.stringify(recents)); } catch { /* ignore */ }
  }

  function baseItems(mode) {
    const docItems = (ctx.docNames ? ctx.docNames() : []).map((name) => ({
      title: 'Open: ' + name, cat: 'Document', keysDisplay: '', run: () => ctx.openDoc(name),
    }));
    if (mode === 'docs') return docItems;
    const cmdItems = commands
      .filter((c) => c.id !== 'palette')
      .map((c) => ({
        title: c.title, cat: c.cat,
        keysDisplay: c.keys && c.keys.length ? prettyKeys(c.keys[0]) : '',
        run: () => c.run(),
      }));
    return cmdItems.concat(docItems);
  }
  let prevFocus = null;   // restore where focus WAS (findbar, sidebar…), not always the editor
  function openPalette(o = {}) {
    open = true;
    prevFocus = document.activeElement;
    pal._all = baseItems(o.mode);
    showBackdrop(true);
    pal.hidden = false;
    input.value = '';
    input.placeholder = o.mode === 'docs' ? 'Jump to a document…' : 'Type a command or document name…';
    filter('');
    input.focus();
  }
  function close() {
    if (!open) return;
    open = false;
    pal.hidden = true;
    showBackdrop(false);
    if (prevFocus && prevFocus.isConnected && prevFocus !== document.body) { try { prevFocus.focus(); } catch { /* ignore */ } }
    else if (ctx.focusEditor) ctx.focusEditor();
    prevFocus = null;
  }
  function filter(query) {
    const all = pal._all || [];
    if (!query) {
      const rank = new Map(recents.map((t, i) => [t, i]));   // recents first, then registry order
      items = all.slice().sort((a, b) => (rank.has(a.title) ? rank.get(a.title) : 999) - (rank.has(b.title) ? rank.get(b.title) : 999)).slice(0, 80);
      for (const it of items) it._hl = null;
    } else {
      items = all.map((it) => {
        const ts = fuzzyMatch(query, it.title);
        if (ts >= 0) { it._hl = matchPositions(query, it.title); return { it, score: ts + 100 }; }  // title matches rank highest
        it._hl = null;                                         // also search the category ("export" → all Export cmds)
        return { it, score: fuzzyMatch(query, (it.cat ? it.cat + ' ' : '') + it.title) };
      }).filter((x) => x.score >= 0).sort((a, b) => b.score - a.score).map((x) => x.it).slice(0, 80);
    }
    sel = 0;
    renderList();
  }
  function renderList() {
    list.replaceChildren();
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'empty'; li.textContent = 'No matches';
      list.appendChild(li);
      return;
    }
    items.forEach((it, i) => {
      const li = document.createElement('li');
      if (i === sel) li.classList.add('sel');
      const cat = document.createElement('span'); cat.className = 'cat'; cat.textContent = it.cat || '';
      const nm = document.createElement('span'); nm.className = 'nm';
      if (it._hl && it._hl.length) {                          // bold the fuzzy-matched characters
        const set = new Set(it._hl);
        for (let c = 0; c < it.title.length; c++) {
          if (set.has(c)) { const b = document.createElement('b'); b.className = 'hl'; b.textContent = it.title[c]; nm.appendChild(b); }
          else nm.appendChild(document.createTextNode(it.title[c]));
        }
      } else nm.textContent = it.title;
      li.append(cat, nm);
      if (it.keysDisplay) {
        const k = document.createElement('span'); k.className = 'k'; k.textContent = it.keysDisplay;
        li.appendChild(k);
      }
      li.addEventListener('click', () => execute(i));
      li.addEventListener('mousemove', () => { if (sel !== i) { sel = i; paint(); } });
      list.appendChild(li);
    });
  }
  function paint() { [...list.children].forEach((li, i) => li.classList.toggle('sel', i === sel)); }
  function move(d) {
    if (!items.length) return;
    sel = (sel + d + items.length) % items.length;
    paint();
    const el = list.children[sel];
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }
  function execute(i) {
    const it = items[i];
    if (!it) return;
    if (it.cat && it.cat !== 'Document') recordUse(it.title);   // remember for the recents ordering
    close();
    it.run();
  }

  input.addEventListener('input', () => filter(input.value.trim()));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); execute(sel); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  return { open: openPalette, close, isOpen: () => open };
}
