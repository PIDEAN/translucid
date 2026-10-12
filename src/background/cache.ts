// Translation cache in IndexedDB: { k: sha256 key, v: translation, t: last used }.
const DB_NAME = 'xt-cache';
const STORE = 'tr';
const MAX_ENTRIES = 60_000;
const EVICT_EVERY = 500;

let dbPromise: Promise<IDBDatabase> | null = null;
let writesSinceEvict = 0;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'k' });
      store.createIndex('t', 't');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

export async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function cacheGetMany(keys: string[]): Promise<(string | undefined)[]> {
  if (!keys.length) return [];
  const tx = (await db()).transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const now = Date.now();
  const results = await Promise.all(
    keys.map(
      (k) =>
        new Promise<string | undefined>((resolve) => {
          const req = store.get(k);
          req.onsuccess = () => {
            const row = req.result as { k: string; v: string; t: number } | undefined;
            if (row) store.put({ ...row, t: now }); // touch for LRU
            resolve(row?.v);
          };
          req.onerror = () => resolve(undefined);
        }),
    ),
  );
  await done(tx).catch(() => {});
  return results;
}

export async function cachePut(k: string, v: string): Promise<void> {
  const tx = (await db()).transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put({ k, v, t: Date.now() });
  await done(tx);
  if (++writesSinceEvict >= EVICT_EVERY) {
    writesSinceEvict = 0;
    void evict();
  }
}

async function evict(): Promise<void> {
  const tx = (await db()).transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const count = await new Promise<number>((r) => {
    const req = store.count();
    req.onsuccess = () => r(req.result);
  });
  let excess = count - MAX_ENTRIES;
  if (excess > 0) {
    const cursorReq = store.index('t').openCursor();
    cursorReq.onsuccess = () => {
      const c = cursorReq.result;
      if (!c || excess-- <= 0) return;
      c.delete();
      c.continue();
    };
  }
  await done(tx);
}

export async function cacheDeleteMany(keys: string[]): Promise<void> {
  if (!keys.length) return;
  const tx = (await db()).transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  for (const k of keys) store.delete(k);
  await done(tx);
}

export async function cacheClear(): Promise<void> {
  const tx = (await db()).transaction(STORE, 'readwrite');
  tx.objectStore(STORE).clear();
  await done(tx);
}

export async function cacheCount(): Promise<number> {
  const tx = (await db()).transaction(STORE, 'readonly');
  return new Promise((r) => {
    const req = tx.objectStore(STORE).count();
    req.onsuccess = () => r(req.result);
  });
}
