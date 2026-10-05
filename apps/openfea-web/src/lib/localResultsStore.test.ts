import { afterEach, describe, expect, test, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local run variant persistence", () => {
  test("saves, loads, and deletes independently keyed case payloads", async () => {
    vi.stubGlobal("indexedDB", fakeIndexedDb());
    vi.stubGlobal("IDBKeyRange", { only: (value: string) => ({ value }) });
    const {
      deleteLocalRunVariantResults,
      loadLocalRunVariantResult,
      saveLocalRunVariantResult
    } = await import("./localResultsStore");

    await saveLocalRunVariantResult("run-1", "case:down", { id: "case:down", fields: [1] });
    await saveLocalRunVariantResult("run-1", "case:side", { id: "case:side", fields: [2] });
    await saveLocalRunVariantResult("run-2", "case:keep", { id: "case:keep", fields: [3] });

    await expect(loadLocalRunVariantResult("run-1", "case:side")).resolves.toEqual({ id: "case:side", fields: [2] });
    await deleteLocalRunVariantResults("run-1");
    await expect(loadLocalRunVariantResult("run-1", "case:down")).resolves.toBeNull();
    await expect(loadLocalRunVariantResult("run-1", "case:side")).resolves.toBeNull();
    await expect(loadLocalRunVariantResult("run-2", "case:keep")).resolves.toEqual({ id: "case:keep", fields: [3] });
  });
});

function fakeIndexedDb(): IDBFactory {
  const stores = new Map<string, Map<string, unknown>>();
  const database = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore(name: string) {
      const entries = new Map<string, unknown>();
      stores.set(name, entries);
      return objectStore(entries);
    },
    transaction(name: string) {
      const entries = stores.get(name);
      if (!entries) throw new Error(`Missing fake IndexedDB store ${name}.`);
      const transaction = {
        error: null,
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onabort: null as (() => void) | null,
        objectStore: () => objectStore(entries)
      };
      setTimeout(() => transaction.oncomplete?.(), 0);
      return transaction;
    },
    close() {}
  };
  return {
    open() {
      const request = {
        result: database,
        error: null,
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onblocked: null as (() => void) | null
      };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    }
  } as unknown as IDBFactory;
}

function objectStore(entries: Map<string, unknown>) {
  return {
    put(value: { key?: string; runId?: string }) {
      entries.set(value.key ?? value.runId ?? "", structuredClone(value));
    },
    get(key: string) {
      return asyncRequest(() => structuredClone(entries.get(key)));
    },
    getAll() {
      return asyncRequest(() => [...entries.values()].map((value) => structuredClone(value)));
    },
    delete(key: string) {
      entries.delete(key);
    },
    createIndex() {},
    index() {
      return {
        getAll(query: { value: string }) {
          return asyncRequest(() => [...entries.values()]
            .filter((value) => (value as { runId?: string }).runId === query.value)
            .map((value) => structuredClone(value)));
        }
      };
    }
  };
}

function asyncRequest(read: () => unknown) {
  const request = {
    result: undefined as unknown,
    error: null,
    onsuccess: null as (() => void) | null,
    onerror: null as (() => void) | null
  };
  queueMicrotask(() => {
    request.result = read();
    request.onsuccess?.();
  });
  return request;
}
