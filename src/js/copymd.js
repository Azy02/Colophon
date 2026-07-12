/* copymd.js — serialize a slice of the rendered preview back to clean
   Markdown/LaTeX text for the clipboard (pure, testable).

   The pain this solves: selecting a rendered equation or table and copying it
   yields KaTeX/þDOM garbage. So the "smart copy" rule is: things whose rendered
   form is NOT faithfully plain text are emitted in source form — equations as
   their original TeX ($…$ / $$…$$, from data-tex), tables as GFM pipe tables,
   code blocks fenced — while ordinary prose (including bold/italic/links/inline
   code) flattens to plain text, so a normal text selection copies clean with no
   stray markers. Given a container holding a cloned Range fragment, returns the
   serialized string (empty if nothing usable). */

function cleanTex(t) {
  return String(t == null ? '' : t)
    .replace(/\\tag\*?\s*\{[^}]*\}/g, '')
    .replace(/\\label\s*\{[^}]*\}/g, '')
    .trim();
}

const BLOCK = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'FIGURE', 'FIGCAPTION', 'SECTION', 'ARTICLE', 'DD', 'DT']);

function tableToPipe(table) {
  const rows = [...table.querySelectorAll('tr')];
  if (!rows.length) return '';
  const cells = rows.map((tr) => [...tr.children]
    .filter((c) => c.nodeType === 1)
    .map((td) => td.textContent.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')));
  const width = Math.max(1, ...cells.map((r) => r.length));
  const line = (r) => '| ' + Array.from({ length: width }, (_, i) => r[i] || '').join(' | ') + ' |';
  const out = [line(cells[0]), '| ' + Array(width).fill('---').join(' | ') + ' |', ...cells.slice(1).map(line)];
  return out.join('\n');
}

function codeBlock(pre) {
  const code = pre.querySelector('code') || pre;
  const lang = (code.className.match(/language-([\w+-]+)/) || [])[1] || '';
  return '```' + lang + '\n' + code.textContent.replace(/\n$/, '') + '\n```';
}

export function serializeSelection(root) {
  let out = '';
  const endBlock = () => { if (out && !out.endsWith('\n')) out += '\n'; };

  const walk = (node) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { out += n.nodeValue; continue; }
      if (n.nodeType !== 1) continue;
      const el = n, cls = el.classList, tag = el.tagName;

      // math: emit original TeX, never descend into KaTeX internals
      if (cls.contains('imath') && el.getAttribute('data-tex') != null) { out += '$' + cleanTex(el.getAttribute('data-tex')) + '$'; continue; }
      if (cls.contains('eq') && el.getAttribute('data-tex') != null) { endBlock(); out += '\n$$\n' + cleanTex(el.getAttribute('data-tex')) + '\n$$\n\n'; continue; }
      // rendered-math internals / caption numbers / a11y-only nodes: skip whole subtree
      if (cls.contains('katex') || cls.contains('katex-display') || cls.contains('katex-mathml') || cls.contains('fig-no') || cls.contains('sr-only') || cls.contains('hnum')) continue;

      if (tag === 'TABLE') { endBlock(); out += '\n' + tableToPipe(el) + '\n\n'; continue; }
      if (tag === 'PRE' || cls.contains('code-wrap')) { endBlock(); out += '\n' + codeBlock(el.tagName === 'PRE' ? el : el.querySelector('pre') || el) + '\n\n'; continue; }
      if (tag === 'BR') { out += '\n'; continue; }
      if (tag === 'HR') { endBlock(); out += '\n---\n\n'; continue; }

      const block = BLOCK.has(tag);
      if (block) endBlock();
      walk(el);
      if (block) endBlock();
    }
  };
  walk(root);
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export default serializeSelection;
