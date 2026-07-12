import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import * as store from '../src/js/store.js';

// Each test gets a pristine IndexedDB via the store's test hook.
function fresh() { const idb = new IDBFactory(); store._injectIDB(idb); return idb; }

test('doc roundtrip', async () => {
  fresh();
  await store.docPut('a.md', 'hello');
  const d = await store.docGet('a.md');
  assert.equal(d.content, 'hello');
  assert.ok(typeof d.mtime === 'number');
  const all = await store.docsAll();
  assert.equal(all.length, 1);
  assert.equal(store.storageMode(), 'idb');
});

test('v1 → v2 migration preserves docs and adds the versions store', async () => {
  const idb = new IDBFactory();
  // Build a raw v1 database (docs + meta only), as older Colophon libraries have.
  await new Promise((res, rej) => {
    const r = idb.open('colophon-lib', 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('docs', { keyPath: 'name' });
      db.createObjectStore('meta');
    };
    r.onsuccess = () => {
      const db = r.result;
      const tx = db.transaction('docs', 'readwrite');
      tx.objectStore('docs').put({ name: 'old.md', content: 'v1 content', mtime: 1 });
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => rej(tx.error);
    };
    r.onerror = () => rej(r.error);
  });
  // Now let the store open (and upgrade) the same database.
  store._injectIDB(idb);
  const d = await store.docGet('old.md');
  assert.equal(d.content, 'v1 content');                 // survived the upgrade
  await store.versionAdd('old.md', 'snapshot', 'save');  // versions store now exists
  const vs = await store.versionsList('old.md');
  assert.equal(vs.length, 1);
});

test('draft flow: put / get / clear', async () => {
  fresh();
  await store.draftPut('a.md', 'draft body');
  const dr = await store.draftGet('a.md');
  assert.equal(dr.content, 'draft body');
  assert.ok(dr.ts > 0);
  await store.draftClear('a.md');
  assert.equal(await store.draftGet('a.md'), undefined);
});

test('versions prune at 30 and list newest-first', async () => {
  fresh();
  for (let i = 1; i <= 35; i++) await store.versionAdd('a.md', 'c' + i, 'save', i * 1000);
  const vs = await store.versionsList('a.md');
  assert.equal(vs.length, 30);
  assert.equal(vs[0].ts, 35000);                          // newest first
  assert.equal(vs[vs.length - 1].ts, 6000);               // oldest five (1000–5000) pruned
});

test('rename carries versions and the draft, and clears the old name', async () => {
  fresh();
  await store.docPut('a.md', 'x');
  await store.versionAdd('a.md', 'v1', 'save');
  await store.draftPut('a.md', 'dr');
  const ok = await store.docRename('a.md', 'b.md');
  assert.equal(ok, true);
  assert.equal(await store.docGet('a.md'), undefined);
  assert.equal((await store.docGet('b.md')).content, 'x');
  assert.equal((await store.versionsList('b.md')).length, 1);
  assert.equal((await store.versionsList('a.md')).length, 0);
  assert.equal((await store.draftGet('b.md')).content, 'dr');
  assert.equal(await store.draftGet('a.md'), undefined);
});

test('assetsGC keeps referenced assets and drops the rest', async () => {
  fresh();
  await store.docPut('a.md', 'inline image colophon-asset:keepme here');
  await store.assetPut('keepme', new Blob(['x']), 'image/png');
  await store.assetPut('dropme', new Blob(['y']), 'image/png');
  const removed = await store.assetsGC();
  assert.equal(removed, 1);
  assert.ok(await store.assetGet('keepme'));
  assert.equal(await store.assetGet('dropme'), undefined);
});

test('assetsGC also honors assets referenced only by a draft', async () => {
  fresh();
  await store.docPut('a.md', 'no images here');
  await store.draftPut('a.md', 'draft uses colophon-asset:draftref');
  await store.assetPut('draftref', new Blob(['z']), 'image/png');
  const removed = await store.assetsGC();
  assert.equal(removed, 0);
  assert.ok(await store.assetGet('draftref'));
});

test('assetsGC keep-list protects ids no document references', async () => {
  fresh();
  await store.docPut('a.md', 'no images');
  await store.assetPut('welcome-fig-damped', new Blob(['<svg/>']), 'image/svg+xml');
  await store.assetPut('refpdf-shannon1948', new Blob(['%PDF']), 'application/pdf');
  await store.assetPut('orphan', new Blob(['x']), 'image/png');
  const removed = await store.assetsGC(['welcome-fig-damped', 'refpdf-shannon1948']);
  assert.equal(removed, 1);
  assert.ok(await store.assetGet('welcome-fig-damped'));
  assert.ok(await store.assetGet('refpdf-shannon1948'));
  assert.equal(await store.assetGet('orphan'), undefined);
});
