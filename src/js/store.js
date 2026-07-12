/* Local persistence. IndexedDB `colophon-lib` v2:
     docs      {name → content, mtime}                      (v1 store, untouched shape)
     meta      out-of-line key/value  (drafts, folder handle, ui bits)
     versions  {id auto → name, ts, content, reason}        (new in v2)
     assets    {id → blob, mime, ts}                        (new in v2)
   A v1 database upgrades in place — user libraries survive. If IndexedDB is
   unavailable (sandboxed iframe, private mode quirks), everything falls back
   to a volatile in-memory store and the UI shows a notice. */

const DB_NAME = 'colophon-lib', DB_VER = 2;
const DOCS = 'docs', META = 'meta', VERS = 'versions', ASSETS = 'assets';

let dbPromise = null;
let memory = null;                    // fallback: { docs:Map, meta:Map, versions:[], assets:Map }
let idbFactory = typeof indexedDB !== 'undefined' ? indexedDB : null;

export function _injectIDB(factory) { idbFactory = factory; dbPromise = null; memory = null; }  // tests

function openDB() {
  if (memory) return Promise.reject(new Error('memory-mode'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((res, rej) => {
    if (!idbFactory) return rej(new Error('no indexedDB'));
    let req;
    try { req = idbFactory.open(DB_NAME, DB_VER); } catch (e) { return rej(e); }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DOCS)) db.createObjectStore(DOCS, { keyPath: 'name' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      if (!db.objectStoreNames.contains(VERS)) {
        const v = db.createObjectStore(VERS, { keyPath: 'id', autoIncrement: true });
        v.createIndex('byName', 'name');
      }
      if (!db.objectStoreNames.contains(ASSETS)) db.createObjectStore(ASSETS, { keyPath: 'id' });
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
    req.onblocked = () => rej(new Error('indexedDB blocked'));
  });
  return dbPromise;
}

function ensureMemory() {
  if (!memory) memory = { docs: new Map(), meta: new Map(), versions: [], assets: new Map(), vSeq: 1 };
  return memory;
}

async function tx(store, mode, fn) {
  try {
    const db = await openDB();
    return await new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const rq = fn(t.objectStore(store));
      t.oncomplete = () => res(rq && 'result' in rq ? rq.result : undefined);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('tx aborted'));
    });
  } catch (e) {
    ensureMemory();
    return memFallback(store, mode, fn, e);
  }
}

/* Memory fallback implements just the operations the app uses. */
function memFallback(store) { throw Object.assign(new Error('memory-dispatch'), { store }); }

export const storageMode = () => (memory ? 'memory' : 'idb');

/* ---------- docs ---------- */
export async function docPut(name, content) {
  const rec = { name, content, mtime: Date.now() };
  try { return await tx(DOCS, 'readwrite', s => s.put(rec)); }
  catch { ensureMemory().docs.set(name, rec); }
}
export async function docGet(name) {
  try { return await tx(DOCS, 'readonly', s => s.get(name)); }
  catch { return ensureMemory().docs.get(name); }
}
export async function docDelete(name) {
  try { return await tx(DOCS, 'readwrite', s => s.delete(name)); }
  catch { ensureMemory().docs.delete(name); }
}
export async function docsAll() {
  try { return (await tx(DOCS, 'readonly', s => s.getAll())) || []; }
  catch { return [...ensureMemory().docs.values()]; }
}
export async function docRename(oldName, newName) {
  const d = await docGet(oldName);
  if (!d) return false;
  await docPut(newName, d.content);
  await docDelete(oldName);
  // carry versions + draft across
  const vs = await versionsList(oldName);
  for (const v of vs) await versionAdd(newName, v.content, v.reason, v.ts);
  await versionsClear(oldName);
  const draft = await metaGet('draft:' + oldName);
  if (draft) { await metaPut('draft:' + newName, draft); await metaDelete('draft:' + oldName); }
  return true;
}

/* ---------- meta ---------- */
export async function metaPut(k, v) {
  try { return await tx(META, 'readwrite', s => s.put(v, k)); }
  catch { ensureMemory().meta.set(k, v); }
}
export async function metaGet(k) {
  try { return await tx(META, 'readonly', s => s.get(k)); }
  catch { return ensureMemory().meta.get(k); }
}
export async function metaDelete(k) {
  try { return await tx(META, 'readwrite', s => s.delete(k)); }
  catch { ensureMemory().meta.delete(k); }
}

/* ---------- drafts (autosave) ---------- */
export const draftPut = (name, content) => metaPut('draft:' + name, { content, ts: Date.now() });
export const draftGet = (name) => metaGet('draft:' + name);
export const draftClear = (name) => metaDelete('draft:' + name);

/* ---------- versions ---------- */
const VERSION_CAP = 30;
export async function versionAdd(name, content, reason = 'save', ts = null) {
  const rec = { name, ts: ts ?? Date.now(), content, reason };
  try {
    await tx(VERS, 'readwrite', s => s.add(rec));
    await versionPrune(name);
  } catch {
    const m = ensureMemory();
    m.versions.push({ ...rec, id: m.vSeq++ });
    const mine = m.versions.filter(v => v.name === name);
    if (mine.length > VERSION_CAP) {
      const drop = new Set(mine.slice(0, mine.length - VERSION_CAP).map(v => v.id));
      m.versions = m.versions.filter(v => !drop.has(v.id));
    }
  }
}
export async function versionsList(name) {
  try {
    const db = await openDB();
    return await new Promise((res, rej) => {
      const t = db.transaction(VERS, 'readonly');
      const rq = t.objectStore(VERS).index('byName').getAll(name);
      rq.onsuccess = () => res((rq.result || []).sort((a, b) => b.ts - a.ts));
      rq.onerror = () => rej(rq.error);
    });
  } catch {
    return ensureMemory().versions.filter(v => v.name === name).sort((a, b) => b.ts - a.ts);
  }
}
async function versionPrune(name) {
  const all = await versionsList(name);
  if (all.length <= VERSION_CAP) return;
  const excess = all.slice(VERSION_CAP);
  try { await tx(VERS, 'readwrite', s => { for (const v of excess) s.delete(v.id); }); } catch { /* memory pruned in add */ }
}
export async function versionsClear(name) {
  const all = await versionsList(name);
  try { await tx(VERS, 'readwrite', s => { for (const v of all) s.delete(v.id); }); }
  catch { const m = ensureMemory(); m.versions = m.versions.filter(v => v.name !== name); }
}

/* ---------- assets (pasted/dropped images) ---------- */
export async function assetPut(id, blob, mime) {
  const rec = { id, blob, mime, ts: Date.now() };
  try { return await tx(ASSETS, 'readwrite', s => s.put(rec)); }
  catch { ensureMemory().assets.set(id, rec); }
}
export async function assetGet(id) {
  try { return await tx(ASSETS, 'readonly', s => s.get(id)); }
  catch { return ensureMemory().assets.get(id); }
}
export async function assetsAll() {
  try { return (await tx(ASSETS, 'readonly', s => s.getAll())) || []; }
  catch { return [...ensureMemory().assets.values()]; }
}
export async function assetDelete(id) {
  try { return await tx(ASSETS, 'readwrite', s => s.delete(id)); }
  catch { ensureMemory().assets.delete(id); }
}
/** Remove assets referenced by no document. `keep` lists ids that are used
    outside document text (seeded showcase figures, reference-attached PDFs,
    folder-mode docs the IDB scan can't see) and must survive collection. */
export async function assetsGC(keep = []) {
  const docs = await docsAll();
  const used = new Set(keep);
  for (const d of docs) for (const m of String(d.content).matchAll(/colophon-asset:([\w-]+)/g)) used.add(m[1]);
  const drafts = [];   // drafts can also reference assets
  for (const d of docs) { const dr = await draftGet(d.name); if (dr) drafts.push(dr.content); }
  for (const c of drafts) for (const m of String(c).matchAll(/colophon-asset:([\w-]+)/g)) used.add(m[1]);
  let removed = 0;
  for (const a of await assetsAll()) if (!used.has(a.id)) { await assetDelete(a.id); removed++; }
  return removed;
}
