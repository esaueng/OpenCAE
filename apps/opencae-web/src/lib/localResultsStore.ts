/**
 * Minimal IndexedDB persistence for completed local solve result bundles,
 * keyed by runId, so getResults can restore them after a page reload.
 *
 * Failure policy (honest results): callers must surface persistence failures —
 * save errors become a visible warning diagnostic on the result summary, and
 * load errors reject with a clear message instead of pretending the run never
 * existed.
 */

const DB_NAME = "opencae-local-results";
const DB_VERSION = 1;
const STORE_NAME = "results";
/** Keep bookkeeping consistent with the in-memory run caches (RUN_BOOKKEEPING_LIMIT). */
const MAX_STORED_RESULTS = 4;

type StoredLocalRunResults = {
  runId: string;
  savedAt: number;
  results: unknown;
};

export function isLocalResultsStoreAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

export async function saveLocalRunResults(runId: string, results: unknown): Promise<void> {
  const db = await openResultsDb();
  try {
    await runTransaction(db, "readwrite", (store) => {
      store.put({ runId, savedAt: Date.now(), results } satisfies StoredLocalRunResults);
    });
    await pruneOldEntries(db);
  } finally {
    db.close();
  }
}

export async function loadLocalRunResults<T>(runId: string): Promise<T | null> {
  const db = await openResultsDb();
  try {
    const entry = await new Promise<StoredLocalRunResults | undefined>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).get(runId);
      request.onsuccess = () => resolve(request.result as StoredLocalRunResults | undefined);
      request.onerror = () => reject(requestError(request.error, "read"));
    });
    return (entry?.results as T | undefined) ?? null;
  } finally {
    db.close();
  }
}

async function pruneOldEntries(db: IDBDatabase): Promise<void> {
  const entries = await new Promise<StoredLocalRunResults[]>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve((request.result ?? []) as StoredLocalRunResults[]);
    request.onerror = () => reject(requestError(request.error, "read"));
  });
  if (entries.length <= MAX_STORED_RESULTS) return;
  const stale = entries
    .sort((left, right) => right.savedAt - left.savedAt)
    .slice(MAX_STORED_RESULTS)
    .map((entry) => entry.runId);
  await runTransaction(db, "readwrite", (store) => {
    for (const runId of stale) store.delete(runId);
  });
}

function openResultsDb(): Promise<IDBDatabase> {
  if (!isLocalResultsStoreAvailable()) {
    return Promise.reject(new Error("Browser storage (IndexedDB) is not available; local results cannot be persisted across reloads."));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "runId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(requestError(request.error, "open"));
    request.onblocked = () => reject(new Error("Browser storage for local results is blocked by another tab."));
  });
}

function runTransaction(db: IDBDatabase, mode: IDBTransactionMode, apply: (store: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(requestError(transaction.error, "write"));
    transaction.onabort = () => reject(requestError(transaction.error, "write"));
    apply(transaction.objectStore(STORE_NAME));
  });
}

function requestError(error: DOMException | null, action: "open" | "read" | "write"): Error {
  if (error?.name === "QuotaExceededError") {
    return new Error("Browser storage quota exceeded; local results were not persisted for reload.");
  }
  return new Error(`Browser storage ${action} failed${error?.message ? `: ${error.message}` : "."}`);
}
