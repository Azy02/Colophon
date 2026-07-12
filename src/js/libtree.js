/* Library tree for folder projects: group a flat recursive listing (relative
   paths) into root entries + one collapsible group per top-level subfolder —
   the folder-IS-the-project model (docs/ON_DISK_PROJECTS.md). Pure module,
   tested directly. */

export const DOC_RE = /\.(md|markdown|mdown|txt|bib|tex)$/i;
export const ASSET_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|pdf)$/i;

/* A path that is safe to show/resolve inside a project: relative, no scheme,
   no leading slash, and no '.'/'..'/empty segments (never walks out). */
export function isSafeRelPath(p) {
  if (typeof p !== 'string' || !p || p.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(p)) return false;
  return p.split('/').every((s) => s && s !== '.' && s !== '..');
}

/* entries: [{name: relativePath, kind: 'doc'|'asset', ...}] →
   { rootDocs, rootAssets, groups: [{dir, docs, assets, count}] }
   Entries keep their FULL relative path in .name; display labels are the
   renderer's business. Unsafe paths are dropped, groups and their contents
   sort by name. */
export function buildLibTree(entries) {
  const rootDocs = [], rootAssets = [];
  const byDir = new Map();
  for (const e of entries || []) {
    if (!e || !isSafeRelPath(e.name)) continue;
    const i = e.name.indexOf('/');
    if (i === -1) { (e.kind === 'asset' ? rootAssets : rootDocs).push(e); continue; }
    const dir = e.name.slice(0, i);
    if (!byDir.has(dir)) byDir.set(dir, { dir, docs: [], assets: [] });
    byDir.get(dir)[e.kind === 'asset' ? 'assets' : 'docs'].push(e);
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  rootDocs.sort(byName); rootAssets.sort(byName);
  const groups = [...byDir.values()].sort((a, b) => a.dir.localeCompare(b.dir));
  for (const g of groups) { g.docs.sort(byName); g.assets.sort(byName); g.count = g.docs.length + g.assets.length; }
  return { rootDocs, rootAssets, groups };
}
