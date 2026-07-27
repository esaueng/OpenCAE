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

/**
 * Read only the lightweight UI autosave on the boot path.
 *
 * The restore shell renders before the lazy workspace chunk, so waiting for
 * WorkspaceApp to parse the full project would paint the default dark theme
 * first. Keep this synchronous and narrowly scoped so the first paint matches
 * the saved workspace without parsing a potentially multi-megabyte autosave.
 */
export function readAutosavedThemeMode(storage = getBrowserStorage()): "dark" | "light" {
  const payload = readStorageItem(storage, AUTOSAVE_UI_STORAGE_KEY);
  if (!payload) return "dark";
  try {
    const snapshot = JSON.parse(payload) as unknown;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return "dark";
    const record = snapshot as Record<string, unknown>;
    if (record.version !== 1 || typeof record.savedAt !== "string") return "dark";
    const ui = record.ui;
    if (!ui || typeof ui !== "object" || Array.isArray(ui)) return "dark";
    return (ui as Record<string, unknown>).themeMode === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}
