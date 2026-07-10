export const AUTOSAVE_STORAGE_KEY = "opencae.workspace.autosave.v1";
export const AUTOSAVE_UI_STORAGE_KEY = "opencae.workspace.ui.autosave.v1";

export interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readStorageItem(storage: StorageLike | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function hasAutosavedWorkspace(storage = getBrowserStorage()): boolean {
  return Boolean(readStorageItem(storage, AUTOSAVE_STORAGE_KEY));
}
