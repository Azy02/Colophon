/* Equation numbering & cross-reference planning. Pure module — no DOM, no KaTeX.
   Operates on the display-math token list collected by the pipeline (in source
   order) and decides, per equation: its number (or none), its anchor id, and
   the KaTeX-ready tex (labels stripped, \tag injected).

   Rules (mirroring LaTeX intuition):
   - `numbering: 'auto'`  → an equation gets a number iff it carries \label{…}
   - `numbering: 'all'`   → every display equation is numbered unless it has
                            \notag / \nonumber, or ends in a starred env
   - `numbering: 'none'`  → no numbers (labels still create anchors)
   - a user-supplied \tag{…} is kept verbatim and becomes the label's display text
*/

const LABEL_RE = /\\label\s*\{([^{}]+)\}/g;
const HAS_TAG_RE = /\\tag\s*\{/;
const NOTAG_RE = /\\(notag|nonumber)\b/;
const STARRED_ENV_RE = /\\begin\s*\{(align|equation|gather|alignat|multline)\*\}/;

export function slugifyLabel(label) {
  return 'eq-' + label.trim().replace(/[^\w:.-]+/g, '-');
}

/**
 * @param {string[]} displayTexList display-math sources in document order
 * @param {'auto'|'all'|'none'} numbering
 * @returns {{ plans: {tex:string, number:number|null, tag:string|null, id:string|null}[],
 *             labels: Map<string,{text:string, id:string}> }}
 */
export function planEquations(displayTexList, numbering = 'auto') {
  const plans = [];
  const labels = new Map();
  let counter = 0;
  for (const orig of displayTexList) {
    let tex = orig;
    const found = [];
    tex = tex.replace(LABEL_RE, (_, l) => { found.push(l.trim()); return ''; }).trim();
    const hasTag = HAS_TAG_RE.test(tex);
    const noTag = NOTAG_RE.test(tex);
    const starred = STARRED_ENV_RE.test(tex);
    tex = tex.replace(NOTAG_RE, '').trim();

    let number = null, tag = null;
    if (hasTag) {
      const m = tex.match(/\\tag\s*\{([^{}]*)\}/);
      tag = m ? m[1] : null;
    } else if (!noTag && !starred && (numbering === 'all' || (numbering === 'auto' && found.length > 0))) {
      number = ++counter;
      tex = tex + `\\tag{${number}}`;
    }
    const id = found.length ? slugifyLabel(found[0]) : (number !== null ? `eq-${number}` : null);
    for (const l of found) labels.set(l, { text: tag ?? (number !== null ? String(number) : '?'), id: slugifyLabel(l) });
    plans.push({ tex, number, tag, id });
  }
  return { plans, labels };
}

/** Replace \eqref{x} inside a TeX string using the label map (KaTeX has no \eqref). */
export function resolveEqrefsInTex(tex, labels) {
  return tex.replace(/\\eqref\s*\{([^{}]+)\}/g, (_, l) => {
    const hit = labels.get(l.trim());
    return `\\text{(${hit ? hit.text : '??'})}`;
  }).replace(/\\ref\s*\{([^{}]+)\}/g, (_, l) => {
    const hit = labels.get(l.trim());
    return hit ? `\\text{${hit.text}}` : `\\text{??}`;
  });
}
