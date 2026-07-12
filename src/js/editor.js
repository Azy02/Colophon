/* CodeMirror 6 editor module — migration Phase 2 (see docs/CODEMIRROR_MIGRATION.md).
   Mounts a CM EditorView and exposes a small adapter API shaped like the app's
   textarea usage. Feature-flagged from main.js (?cm=1 / localStorage colophon-cm=1):
   the <textarea> stays the default editor and the source of truth until the
   migration completes; main.js runs a two-way bridge between the two.

   The highlight band (preview→editor selection mirroring) is a set of LINE
   DECORATIONS, not a pixel-measured overlay — CM renders it as part of the
   document, so it cannot drift from the real wrapping and costs no scroll
   handler. This is the foundation Phase 5 builds the full mirror on. */

import { EditorView, keymap, drawSelection, dropCursor, Decoration } from '@codemirror/view';
import { StateField, StateEffect, Annotation, Transaction } from '@codemirror/state';
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';

/* Programmatic whole-doc updates (bridge syncs, document loads) are annotated so
   the update listener can tell them apart from the user's typing. */
const External = Annotation.define();

/* line-band highlight (0-based inclusive line range, matching main.js) */
const setBand = StateEffect.define();
const bandDeco = Decoration.line({ class: 'cm-src-linked' });
const bandField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setBand)) continue;
      if (!e.value) { deco = Decoration.none; continue; }
      const doc = tr.state.doc;
      const a = Math.max(1, Math.min(doc.lines, e.value.start + 1));   // 0-based → CM's 1-based
      const b = Math.max(a, Math.min(doc.lines, e.value.end + 1));
      const marks = [];
      for (let n = a; n <= b; n++) marks.push(bandDeco.range(doc.line(n).from));
      deco = Decoration.set(marks);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/* colors/metrics come from the app's CSS custom properties so the CM surface
   follows the chrome theme and the editor font/size settings automatically */
const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--text)',
    fontFamily: 'var(--editor-font, var(--mono))', fontSize: 'var(--editor-fs, 14.5px)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.7', overflow: 'auto' },
  '.cm-content': { padding: '24px 0', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 clamp(16px, 3vw, 34px)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground':
    { background: 'color-mix(in srgb, var(--accent) 26%, var(--editor-bg)) !important' },
  '.cm-src-linked': { background: 'color-mix(in srgb, var(--accent) 15%, transparent)' },
});

export function createEditor({ parent, doc, onDocChange, onSelect, onScroll }) {
  const view = new EditorView({
    doc: doc || '',
    parent,
    extensions: [
      history(),
      drawSelection(), dropCursor(),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage }),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      bandField,
      theme,
      keymap.of([
        // parity with the textarea: Tab types two spaces (never a focus trap surprise mid-doc)
        { key: 'Tab', run: (v) => { v.dispatch(v.state.replaceSelection('  ')); return true; } },
        // NB: list/quote continuation on Enter is handled by @codemirror/lang-markdown's
        // own `insertNewlineContinueMarkup` (installed at Prec.high by markdown()), which is
        // syntax-tree aware — it does NOT fire inside code fences and renumbers correctly.
        // A hand-rolled Enter binding here was shadowed on real list lines and only reached
        // inside fences, where it injected stray markers; removed.
        ...defaultKeymap, ...historyKeymap,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && onDocChange && !u.transactions.some((t) => t.annotation(External))) onDocChange(u);
        if (u.selectionSet && onSelect) onSelect(u);
      }),
      EditorView.domEventHandlers({ scroll: (e, v) => { if (onScroll && e.target === v.scrollDOM) onScroll(v); } }),
    ],
  });

  const clampPos = (p) => Math.max(0, Math.min(view.state.doc.length, p | 0));
  return {
    view,
    scroller: view.scrollDOM,
    contentDOM: view.contentDOM,
    getValue: () => view.state.doc.toString(),
    setValue(text) {   // a LOAD: not undoable (⌘Z must never revert a document load to empty)
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text },
        annotations: [External.of(true), Transaction.addToHistory.of(false)] });
    },
    setValueBridged(text) {   // a bridged EDIT (applyEdit/find): undoable, but no echo
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text },
        annotations: External.of(true) });
    },
    getSelection() { const r = view.state.selection.main; return { start: r.from, end: r.to }; },
    setSelection(start, end, { scroll = true } = {}) {
      view.dispatch({ selection: { anchor: clampPos(start), head: clampPos(end ?? start) },
        scrollIntoView: scroll, annotations: External.of(true) });
    },
    replaceRange(from, to, text, sel) {   // undo-preserving (a normal CM transaction)
      view.dispatch({ changes: { from: clampPos(from), to: clampPos(to), insert: text },
        selection: sel ? { anchor: clampPos(sel[0]), head: clampPos(sel[1]) } : undefined });
    },
    focus: () => view.focus(),
    hasFocus: () => view.hasFocus,
    highlightLines(start, end) { view.dispatch({ effects: setBand.of({ start, end }) }); },
    clearHighlight() { view.dispatch({ effects: setBand.of(null) }); },
    scrollToLine(line) {   // 0-based; centers the line if it's off-screen
      const n = Math.max(1, Math.min(view.state.doc.lines, line + 1));
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.line(n).from, { y: 'center' }) });
    },
    lineTop(line) {   // 0-based → pixel Y in SCROLLER space (estimated for unmeasured lines)
      const n = Math.max(1, Math.min(view.state.doc.lines, line + 1));
      // lineBlockAt().top is document-relative; the scroller adds .cm-content's
      // top padding, so add it back or every editor-side sync anchor sits ~24px high
      return view.lineBlockAt(view.state.doc.line(n).from).top + view.documentPadding.top;
    },
    lineAtOffset: (off) => view.state.doc.lineAt(clampPos(off)).number - 1,
    offsetOfLine: (line) => view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, line + 1))).from,
  };
}
