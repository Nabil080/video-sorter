// Everything the app remembers lives in IndexedDB, in this browser only.

const DB_NAME = "video-sorter";
const STORES = ["decisions", "thumbs", "folders"];

let db = null;

function openDb() {
  if (!db) {
    db = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);

      request.onupgradeneeded = () => {
        for (const name of STORES) {
          request.result.createObjectStore(name);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return db;
}

async function run(storeName, mode, makeRequest) {
  const database = await openDb();

  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, mode);
    const request = makeRequest(tx.objectStore(storeName));

    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
  });
}

export function get(storeName, key) {
  return run(storeName, "readonly", (store) => store.get(key));
}

export function put(storeName, key, value) {
  return run(storeName, "readwrite", (store) => store.put(value, key));
}

export function remove(storeName, key) {
  return run(storeName, "readwrite", (store) => store.delete(key));
}

// Returns [key, value] pairs.
export async function getAll(storeName) {
  const database = await openDb();

  return new Promise((resolve, reject) => {
    const tx = database.transaction(storeName, "readonly");
    const keys = tx.objectStore(storeName).getAllKeys();
    const values = tx.objectStore(storeName).getAll();

    tx.oncomplete = () => resolve(keys.result.map((key, i) => [key, values.result[i]]));
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearAll() {
  for (const name of STORES) {
    await run(name, "readwrite", (store) => store.clear());
  }
}
