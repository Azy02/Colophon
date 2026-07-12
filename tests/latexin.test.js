import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertLatex, looksLikeLatex } from '../src/js/latexin.js';

const conv = (s) => convertLatex(s).text;

/* ------------------------------------------------ detection */
test('looksLikeLatex: real LaTeX yes, markdown no', () => {
  assert.ok(looksLikeLatex('\\documentclass{article}\\begin{document}hi\\end{document}'));
  assert.ok(looksLikeLatex('\\section{A}\n\\textbf{b}\n\\cite{x}'));
  assert.ok(!looksLikeLatex('# Heading\n\nSome **markdown** with $x^2$ math.\n'));
  assert.ok(!looksLikeLatex('code with a \\n escape and one \\emph{word}'));
});

/* ------------------------------------------------ structure */
test('sections map to heading levels (starred too)', () => {
  const out = conv('\\section{One}\ntext\n\\subsection*{Two}\n\\subsubsection{Three}');
  assert.match(out, /^## One$/m);
  assert.match(out, /^### Two$/m);
  assert.match(out, /^#### Three$/m);
});

test('document wrapper: preamble dropped and reported, body kept', () => {
  const r = convertLatex('\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\nHello.\n\\end{document}');
  assert.match(r.text, /Hello\./);
  assert.ok(!/documentclass|usepackage/.test(r.text));
  assert.ok(r.notes.some((n) => n.what.includes('preamble')));
});

test('title/author become front matter', () => {
  const out = conv('\\title{My Paper}\\author{A. Author \\and B. Author}\\begin{document}\\maketitle\nBody.\n\\end{document}');
  assert.match(out, /^---\ntitle: My Paper\nauthor: A. Author, B. Author\n---/);
  assert.ok(!out.includes('\\maketitle'));
});

/* ------------------------------------------------ inline */
test('inline styles, nested', () => {
  const out = conv('\\textbf{bold and \\emph{nested italic}} plus \\texttt{mono}.');
  assert.equal(out.trim(), '**bold and *nested italic*** plus `mono`.');
});

test('links, urls, citations', () => {
  const out = conv('See \\href{https://x.org}{the site}, \\url{https://y.org}, and \\cite{knuth84,lamport94}.');
  assert.match(out, /\[the site\]\(https:\/\/x\.org\)/);
  assert.match(out, /<https:\/\/y\.org>/);
  assert.match(out, /\[@knuth84\] \[@lamport94\]/);
});

/* ------------------------------------------------ math: content untouched, delimiters canonical */
test('math content is untouched; delimiters become $ / $$ / aligned', () => {
  const src = 'Inline \\(\\textbf{x}+1\\) and display \\[ E = mc^2 \\] and\n\\begin{align}a&=b\\\\c&=d\\end{align}\n';
  const out = conv(src);
  assert.ok(out.includes('$\\textbf{x}+1$'), 'inline math body untouched, \\(..\\) → $..$');
  assert.match(out, /\$\$\nE = mc\^2\n\$\$/, '\\[..\\] → $$ on own lines');
  assert.ok(out.includes('\\begin{aligned}a&=b\\\\c&=d\n\\end{aligned}'), 'align → KaTeX aligned');
  assert.doesNotMatch(out, /\\begin\{align\}/, 'no bare align env survives');
});

test('equation wrapper drops, gather → gathered, $-forms pass through byte-identical', () => {
  const out = conv('\\begin{equation}E=mc^2\\end{equation}\n\\begin{gather*}a\\\\b\\end{gather*}\nkeep $x^2$ and $$y_3$$.');
  assert.match(out, /\$\$\nE=mc\^2\n\$\$/, 'equation unwrapped into $$');
  assert.ok(out.includes('\\begin{gathered}a\\\\b\n\\end{gathered}'), 'gather → gathered');
  assert.ok(out.includes('$x^2$') && out.includes('$$y_3$$'), 'existing $ math untouched');
});

test('end-to-end: LaTeX fragment → clean Colophon markdown (no second pass needed)', () => {
  const src = '\\section{Result}\nThe energy is \\[ E = mc^2 \\] as shown.';
  const out = conv(src);
  assert.match(out, /^## Result$/m);
  assert.match(out, /\$\$\nE = mc\^2\n\$\$/);
});

test('multline/eqnarray have no KaTeX form — kept verbatim, never mangled', () => {
  const out = conv('\\begin{eqnarray}a&=&b\\end{eqnarray}');
  assert.ok(out.includes('\\begin{eqnarray}a&=&b\\end{eqnarray}'));
});

/* Finalization-sweep regressions (2026-07-12): display blocks must be
   blank-line ISOLATED — a $$ block mid-paragraph splits the <p> in the
   rendered DOM and orphans the trailing prose as a bare text node (the
   removed cleanup engine used to force this; canonMath now owns it). */
test('mid-sentence display math gets blank-line isolation', () => {
  const out = conv('The energy \\[ E = mc^2 \\] is famous.');
  assert.match(out, /\n\n\$\$\nE = mc\^2\n\$\$\n\n/);
  const out2 = conv('The formula is\n\\[\nE=mc^2\n\\]\nwhich shows.');
  assert.match(out2, /is\n\n\$\$\nE=mc\^2\n\$\$\n\nwhich shows\./);
  assert.equal(conv(out), out, 'isolation is idempotent (no blank-line growth)');
});

test('nested $$ inside \\[..\\] never leaks a raw sentinel token', () => {
  const out = conv('Consider \\[ \n $$ x = y $$ \n \\] as odd nesting.');
  assert.doesNotMatch(out, /[]/, 'no PUA sentinel in output');
});

test('\\(x\\)5 keeps its \\(..\\) form (the $-currency guard would kill "$x$5")', () => {
  const out = conv('value \\(x\\)5 here and normal \\(y\\) too.');
  assert.ok(out.includes('\\(x\\)5'), 'digit-followed inline math left in \\(..\\) form');
  assert.ok(out.includes('$y$'), 'ordinary inline math still canonicalizes');
});

/* ------------------------------------------------ verbatim & comments */
test('verbatim/lstlisting/minted become fences; % inside survives', () => {
  const out = conv('\\begin{lstlisting}[language=Python]\nx = 1 % not a comment\n\\end{lstlisting}\nprose % comment gone');
  assert.match(out, /```Python\nx = 1 % not a comment\n```/);
  assert.ok(!out.includes('comment gone'));
});

test('\\verb inline becomes backticks', () => {
  assert.match(conv('use \\verb|a_b| here'), /`a_b`/);
});

/* ------------------------------------------------ figures & tables */
test('figure env → Colophon image with caption and {#fig:id}', () => {
  const src = '\\begin{figure}[htbp]\\centering\n\\includegraphics[width=0.8\\textwidth]{plots/energy.png}\n\\caption{Kink energy}\\label{fig:energy}\n\\end{figure}';
  const out = conv(src);
  assert.match(out, /!\[Kink energy\]\(plots\/energy\.png\) \{#fig:energy\}/);
});

test('simple tabular → pipe table with caption', () => {
  const src = '\\begin{table}[h]\\begin{tabular}{ll}\\hline Metal & a0 \\\\ W & 3.165 \\\\ \\hline\\end{tabular}\\caption{Lattice}\\end{table}';
  const out = conv(src);
  assert.match(out, /\| Metal \| a0 \|/);
  assert.match(out, /\| W \| 3\.165 \|/);
  assert.match(out, /Table: Lattice/);
});

test('multicolumn tables are left verbatim and reported', () => {
  const src = '\\begin{table}\\begin{tabular}{ll}\\multicolumn{2}{c}{x}\\\\a&b\\end{tabular}\\end{table}';
  const r = convertLatex(src);
  assert.ok(r.text.includes('\\multicolumn'), 'left as-is');
  assert.ok(r.notes.some((n) => n.what.includes('complex table')));
});

test('pipe-table separator survives the char-level pass (--- not turned into em-dash)', () => {
  // regression: the em-dash rule used to rewrite the "---" delimiter row to "—",
  // which GFM does not recognize, so every imported table failed to render.
  const out = conv('\\begin{table}\\begin{tabular}{ll}A & B \\\\ 1 & 2\\end{tabular}\\caption{C}\\end{table}');
  assert.match(out, /\|[- ]*---[- ]*\|/, 'delimiter row keeps literal ---');
  assert.doesNotMatch(out, /\|\s*—\s*\|/, 'no em-dash delimiter');
});

test('bare tabular (no table wrapper) converts too, instead of being mangled', () => {
  const r = convertLatex('\\begin{tabular}{lll}\na & b & c \\\\\n1 & 2 & 3\n\\end{tabular}');
  assert.match(r.text, /\| a \| b \| c \|/);
  assert.match(r.text, /\| 1 \| 2 \| 3 \|/);
  assert.doesNotMatch(r.text, /\\begin\{tabular\}/, 'not left as raw LaTeX');
  assert.ok(r.notes.some((n) => n.what === 'tables converted'));
});

test('escaped ampersand inside a cell is a literal &, not a column break', () => {
  const out = conv('\\begin{tabular}{ll}AT\\&T & Bell \\\\ x & y\\end{tabular}');
  assert.match(out, /\| AT&T \| Bell \|/);
});

test('redundant "Figure"/"Table" word before a fig/tbl \\ref is dropped (no "Figure Figure N")', () => {
  // Colophon renders \ref{fig:x} as the full "Figure N"; LaTeX authors write
  // "Figure~\ref{fig:x}", so the leading word must be dropped on import.
  const out = conv('See Figure~\\ref{fig:s}, Table~\\ref{tbl:x}, and Fig.~\\ref{fig:y}.');
  assert.match(out, /See \\ref\{fig:s\}, \\ref\{tbl:x\}, and \\ref\{fig:y\}\./);
  // an equation \eqref keeps its word (renders as "(N)", so "Eq. (N)" is correct)
  assert.match(conv('Eq.~\\eqref{e}'), /Eq\. \\eqref\{e\}/);
});

test('looksLikeLatex rejects a Markdown doc with front matter + code fence (guards the whole-doc convert)', () => {
  // the palette convert command refuses to run on !looksLikeLatex input; this is
  // the detection contract that keeps it from shredding a real Markdown document.
  assert.ok(!looksLikeLatex('---\ntitle: X\n---\n\n# H\n\n```py\nx = 1  # 50% done\n```\n\nText -- with dashes.'));
});

/* ------------------------------------------------ lists */
test('nested itemize/enumerate convert with indentation', () => {
  const src = '\\begin{enumerate}\\item first\\item second\n\\begin{itemize}\\item inner\\end{itemize}\n\\end{enumerate}';
  const out = conv(src);
  assert.match(out, /1\. first/);
  assert.match(out, /2\. second/);
  assert.match(out, /- inner/);
});

test('description lists become bold terms', () => {
  const out = conv('\\begin{description}\\item[Alpha] first thing\\end{description}');
  assert.match(out, /- \*\*Alpha\*\* first thing/);
});

/* ------------------------------------------------ footnotes, chars, leftovers */
test('footnotes hoist to reference style', () => {
  const out = conv('Claim\\footnote{The evidence.} continues.');
  assert.match(out, /Claim\[\^lx1\] continues\./);
  assert.match(out, /^\[\^lx1\]: The evidence\.$/m);
});

test('TeX quotes, dashes, ties, escapes, ellipsis', () => {
  const out = conv("``quoted'' text -- dash --- em, A~B, 50\\% \\& more \\ldots");
  assert.match(out, /“quoted” text – dash — em, A B, 50% & more …/);
});

test('unrecognized commands are left verbatim and counted, confidence reflects it', () => {
  const r = convertLatex('\\weirdcmd{x} and \\anotherone[y]{z} in prose.');
  assert.ok(r.text.includes('\\weirdcmd'), 'not guessed away');
  assert.ok(r.notes.some((n) => n.what.includes('unrecognized')));
  assert.equal(convertLatex('plain prose').confidence, 'high');
});

test('plain markdown passes through essentially unchanged (safety)', () => {
  const src = '# Title\n\nSome **bold**, a [link](https://x.org), and $x^2$ math.\n\n- a\n- b\n';
  const out = conv(src);
  assert.equal(out, src);
});

test('output is stable: converting twice changes nothing (structure gone after pass 1)', () => {
  const src = '\\section{A}\\textbf{b} \\cite{k} \\begin{itemize}\\item x\\end{itemize}';
  const once = conv(src);
  assert.equal(conv(once), once);
});

/* Debug-sweep regressions (2026-07-09): footnote bodies must be REAL text in
   the output — processed by every pass and free of sentinel characters. */
test('math inside \\footnote survives (no sentinel leak, no equation loss)', () => {
  const r = convertLatex('Claim.\\footnote{The bound is $x^2$ here.}');
  assert.match(r.text, /\[\^lx1\]: The bound is \$x\^2\$ here\./);
  assert.doesNotMatch(r.text, /[-]/);   // no PUA sentinels anywhere
});

test('footnote bodies get inline-style + logo + char passes and count leftovers', () => {
  const r = convertLatex('X.\\footnote{This is \\textbf{important}, set with \\LaTeX{} --- and \\weirdcmd{x}.}');
  assert.match(r.text, /\[\^lx1\]: This is \*\*important\*\*, set with LaTeX — and \\weirdcmd\{x\}\./);
  assert.ok(r.notes.some((n) => n.what.includes('unrecognized')), 'footnote leftovers counted');
});

test('front-matter title unescapes specials like the body does', () => {
  const r = convertLatex('\\title{Revenue \\& Growth}\\begin{document}\\maketitle Body.\\end{document}');
  assert.match(r.text, /title: Revenue & Growth/);
});
