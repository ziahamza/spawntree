/**
 * IndexedDB-backed store for `FileSystemDirectoryHandle` objects.
 *
 * This store exists ONLY because `FileSystemDirectoryHandle` is a
 * non-serialisable browser object that cannot live in SQLite (or any
 * text/blob column). It can only be persisted via IDB
 * structured-cloning. All other folder metadata lives in the
 * spawntree-browser SQLite catalog (`picked_folders`).
 *
 * The store is keyed by the picked-folder id (UUIDv7 — matches
 * `picked_folders.id`). Lifetime is tied to the browser profile +
 * origin. The IDB database name is `spawntree-fsa-handles` — the prefix
 * keeps the name namespaced so multiple SpawnTree-aware apps on the
 * same origin don't collide.
 */

const DB_NAME = "spawntree-fsa-handles";
const STORE_NAME = "handles";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      console.warn("[spawntree-browser:handle-store] open failed:", req.error);
      resolve(null);
    };
  });
  return dbPromise;
}

export async function getHandle(folderId: string): Promise<FileSystemDirectoryHandle | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise<FileSystemDirectoryHandle | null>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(folderId);
      req.onsuccess = () => {
        const value = req.result;
        if (value && typeof value === "object" && "kind" in value && value.kind === "directory") {
          resolve(value as FileSystemDirectoryHandle);
        } else {
          resolve(null);
        }
      };
      req.onerror = () => {
        console.warn("[spawntree-browser:handle-store] get failed:", req.error);
        resolve(null);
      };
    } catch (err) {
      console.warn("[spawntree-browser:handle-store] get threw:", err);
      resolve(null);
    }
  });
}

export async function putHandle(
  folderId: string,
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(handle, folderId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        console.warn("[spawntree-browser:handle-store] put failed:", tx.error);
        resolve();
      };
    } catch (err) {
      console.warn("[spawntree-browser:handle-store] put threw:", err);
      resolve();
    }
  });
}

export async function deleteHandle(folderId: string): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(folderId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => {
        console.warn("[spawntree-browser:handle-store] delete failed:", tx.error);
        resolve();
      };
    } catch (err) {
      console.warn("[spawntree-browser:handle-store] delete threw:", err);
      resolve();
    }
  });
}
