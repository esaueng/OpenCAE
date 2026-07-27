import { describe, expect, test, vi } from "vitest";
import {
  AUTOSAVE_STORAGE_KEY,
  AUTOSAVE_UI_STORAGE_KEY,
  hasAutosavedWorkspace,
  readAutosavedThemeMode,
  readStorageItem
} from "./autosaveStorage";

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

  test("reads the saved light theme from the lightweight UI snapshot", () => {
    const storage = {
      getItem: vi.fn((key: string) => key === AUTOSAVE_UI_STORAGE_KEY
        ? JSON.stringify({
            version: 1,
            savedAt: "2026-07-27T22:00:00.000Z",
            ui: { themeMode: "light" }
          })
        : null),
      setItem: vi.fn()
    };

    expect(readAutosavedThemeMode(storage)).toBe("light");
    expect(storage.getItem).toHaveBeenCalledWith(AUTOSAVE_UI_STORAGE_KEY);
  });

  test.each([
    ["missing", null],
    ["malformed", "{"],
    ["wrong version", JSON.stringify({ version: 2, savedAt: "2026-07-27T22:00:00.000Z", ui: { themeMode: "light" } })],
    ["unknown theme", JSON.stringify({ version: 1, savedAt: "2026-07-27T22:00:00.000Z", ui: { themeMode: "solarized" } })]
  ])("defaults to dark for a %s UI snapshot", (_label, payload) => {
    const storage = {
      getItem: vi.fn(() => payload),
      setItem: vi.fn()
    };

    expect(readAutosavedThemeMode(storage)).toBe("dark");
  });
});
