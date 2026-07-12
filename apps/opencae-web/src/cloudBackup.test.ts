import { describe, expect, test, vi } from "vitest";
import type { AutosavedWorkspace } from "./appPersistence";
import { readCloudBackupDescriptor, requestPersistentBrowserStorage, restoreEncryptedCloudBackup, saveEncryptedCloudBackup } from "./cloudBackup";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  };
}

describe("encrypted cloud backup", () => {
  test("uploads ciphertext only and restores it with the locally retained key", async () => {
    const storage = memoryStorage();
    const snapshot = { version: 1, savedAt: "2026-07-12T12:00:00.000Z" } as AutosavedWorkspace;
    let uploaded: Blob | null = null;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        uploaded = init.body as Blob;
        expect(await uploaded.text()).not.toContain(snapshot.savedAt);
        return Response.json({ expiresAt: "2026-08-11T12:00:00.000Z" }, { status: 201 });
      }
      return new Response(uploaded, { status: 200, headers: { "content-type": "application/octet-stream" } });
    });

    const descriptor = await saveEncryptedCloudBackup(snapshot, "run-local-1", { fetch: fetchMock as typeof fetch, storage });
    const restored = await restoreEncryptedCloudBackup("run-local-1", { fetch: fetchMock as typeof fetch, storage });

    expect(descriptor.token).not.toBe(descriptor.encryptionKey);
    expect(readCloudBackupDescriptor(storage)).toEqual(descriptor);
    expect(restored).toEqual(snapshot);
  });

  test("does not restore a backup for a different run", async () => {
    const storage = memoryStorage();
    await saveEncryptedCloudBackup({ version: 1 } as AutosavedWorkspace, "run-local-1", {
      storage,
      fetch: vi.fn(async () => Response.json({ expiresAt: "2099-01-01T00:00:00.000Z" }, { status: 201 })) as typeof fetch
    });
    const fetchMock = vi.fn();

    await expect(restoreEncryptedCloudBackup("run-local-2", { storage, fetch: fetchMock as typeof fetch })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("requests persistent local storage when the browser supports it", async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal("navigator", { storage: { persist } });

    await expect(requestPersistentBrowserStorage()).resolves.toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
