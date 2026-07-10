import { describe, expect, test, vi } from "vitest";
import { AUTOSAVE_STORAGE_KEY, hasAutosavedWorkspace, readStorageItem } from "./autosaveStorage";

describe("autosave storage access", () => {
  test("finds a saved workspace through the shared key", () => {
    const storage = {
      getItem: vi.fn((key: string) => key === AUTOSAVE_STORAGE_KEY ? "saved" : null),
      setItem: vi.fn()
    };

    expect(hasAutosavedWorkspace(storage)).toBe(true);
    expect(storage.getItem).toHaveBeenCalledWith(AUTOSAVE_STORAGE_KEY);
  });

  test("treats denied browser storage reads as unavailable", () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new DOMException("Storage access denied", "SecurityError");
      }),
      setItem: vi.fn()
    };

    expect(readStorageItem(storage, AUTOSAVE_STORAGE_KEY)).toBeNull();
    expect(hasAutosavedWorkspace(storage)).toBe(false);
  });
});
