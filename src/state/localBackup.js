const DB_NAME = 'tripcanvas_local_backup_v1';
const DB_VERSION = 1;
const STORE_NAME = 'workspaces';
const PRIMARY_KEY = 'primary_v5';

let writeQueue = Promise.resolve();

function openBackupDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return resolve(null);
    }
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    } catch (err) {
      reject(err);
    }
  });
}

function cloneSnapshot(workspace) {
  try {
    if (typeof structuredClone === 'function') {
      return structuredClone(workspace);
    }
    return JSON.parse(JSON.stringify(workspace));
  } catch {
    return workspace;
  }
}

/**
 * 串行化 IndexedDB 寫入佇列並拍下不可變快照，避免連續快速存檔造成舊狀態覆寫新狀態
 */
export function saveWorkspaceToIndexedDB(workspace) {
  const snapshot = cloneSnapshot(workspace);
  const job = writeQueue.then(async () => {
    try {
      const db = await openBackupDb();
      if (!db) return false;
      return await new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put(snapshot, PRIMARY_KEY);
        tx.oncomplete = () => {
          db.close();
          resolve(true);
        };
        tx.onerror = () => {
          db.close();
          resolve(false);
        };
        tx.onabort = () => {
          db.close();
          resolve(false);
        };
      });
    } catch {
      return false;
    }
  });
  writeQueue = job.catch(() => {});
  return job;
}

export async function loadWorkspaceFromIndexedDB() {
  // 先等待既有寫入完成，確保讀到最新資料
  await writeQueue.catch(() => {});
  try {
    const db = await openBackupDb();
    if (!db) return null;
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(PRIMARY_KEY);
      req.onsuccess = () => {
        const val = req.result || null;
        db.close();
        resolve(val);
      };
      req.onerror = () => {
        db.close();
        resolve(null);
      };
    });
  } catch {
    return null;
  }
}
