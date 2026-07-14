const DB_NAME = "opencae-recent-projects";
const DB_VERSION = 1;
const STORE_NAME = "projects";
export const MAX_RECENT_PROJECTS = 8;

export interface RecentProjectFileHandle {
  kind?: "file";
  name: string;
  getFile: () => Promise<File>;
  isSameEntry?: (other: RecentProjectFileHandle) => Promise<boolean>;
  queryPermission?: (descriptor: { mode: "read" }) => Promise<PermissionState>;
  requestPermission?: (descriptor: { mode: "read" }) => Promise<PermissionState>;
}

export interface RecentProjectEntry {
  id: string;
  filename: string;
  projectName: string;
  lastOpenedAt: number;
  handle: RecentProjectFileHandle;
}

export interface RecentProjectPersistence {
  readAll: () => Promise<RecentProjectEntry[]>;
  replaceAll: (entries: RecentProjectEntry[]) => Promise<void>;
}

export interface RecentProjectService {
  list: () => Promise<RecentProjectEntry[]>;
  add: (handle: RecentProjectFileHandle, metadata: { filename?: string; projectName: string; lastOpenedAt?: number }) => Promise<RecentProjectEntry[]>;
  remove: (id: string) => Promise<RecentProjectEntry[]>;
  clear: () => Promise<void>;
}

export function createRecentProjectService(
  persistence: RecentProjectPersistence,
  options: { createId?: () => string; now?: () => number } = {}
): RecentProjectService {
  const createId = options.createId ?? createRecentProjectId;
  const now = options.now ?? Date.now;
  const list = async () => sortRecentProjects(await persistence.readAll());
  return {
    list,
    add: async (handle, metadata) => {
      const entries = await list();
      let match: RecentProjectEntry | undefined;
      for (const entry of entries) {
        if (await sameFileHandle(handle, entry.handle)) {
          match = entry;
          break;
        }
      }
      const candidate: RecentProjectEntry = {
        id: match?.id ?? createId(),
        filename: metadata.filename ?? handle.name,
        projectName: metadata.projectName,
        lastOpenedAt: metadata.lastOpenedAt ?? now(),
        handle
      };
      const next = sortRecentProjects([candidate, ...entries.filter((entry) => entry.id !== match?.id)]).slice(0, MAX_RECENT_PROJECTS);
      await persistence.replaceAll(next);
      return next;
    },
    remove: async (id) => {
      const next = (await list()).filter((entry) => entry.id !== id);
      await persistence.replaceAll(next);
      return next;
    },
    clear: async () => persistence.replaceAll([])
  };
}

export function isRecentProjectsSupported(): boolean {
  return typeof window !== "undefined" && typeof (window as RecentProjectPickerWindow).showOpenFilePicker === "function" && typeof indexedDB !== "undefined";
}

export function defaultRecentProjectService(): RecentProjectService {
  return createRecentProjectService(indexedDbRecentProjectPersistence());
}

export async function requestRecentProjectFile(entry: RecentProjectEntry): Promise<File> {
  const descriptor = { mode: "read" } as const;
  const permission = entry.handle.queryPermission ? await entry.handle.queryPermission(descriptor) : "prompt";
  const resolvedPermission = permission === "granted"
    ? permission
    : entry.handle.requestPermission
      ? await entry.handle.requestPermission(descriptor)
      : "denied";
  if (resolvedPermission !== "granted") throw new Error(`Read permission was denied for ${entry.filename}.`);
  try {
    return await entry.handle.getFile();
  } catch (error) {
    if (errorName(error) === "NotFoundError") throw new Error(`${entry.filename} is missing or was moved.`);
    throw new Error(`Could not open ${entry.filename}.`);
  }
}

export async function projectNameFromFile(file: File): Promise<string> {
  let payload: unknown;
  try {
    payload = JSON.parse(await file.text()) as unknown;
  } catch {
    throw new Error("The selected file is not a valid OpenCAE project file.");
  }
  const candidate = isRecord(payload) && "project" in payload ? payload.project : payload;
  // Keep the schema package out of the start-screen bootstrap chunk; full
  // validation is needed only after a user selects a file.
  const { ProjectSchema } = await import("@opencae/schema");
  const parsed = ProjectSchema.safeParse(candidate);
  if (!parsed.success) throw new Error("The selected file is not a valid OpenCAE project file.");
  return parsed.data.name;
}

export interface RecentProjectPickerWindow extends Window {
  showOpenFilePicker?: (options: {
    multiple: false;
    types: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<RecentProjectFileHandle[]>;
}

export async function pickRecentProjectFile(): Promise<{ file: File; handle: RecentProjectFileHandle } | "cancelled"> {
  const picker = (window as RecentProjectPickerWindow).showOpenFilePicker;
  if (!picker) return "cancelled";
  try {
    const [handle] = await picker({
      multiple: false,
      types: [{ description: "OpenCAE project", accept: { "application/json": [".json", ".opencae"] } }]
    });
    if (!handle) return "cancelled";
    return { handle, file: await handle.getFile() };
  } catch (error) {
    if (errorName(error) === "AbortError") return "cancelled";
    throw new Error("Could not open the project picker.");
  }
}

function sortRecentProjects(entries: RecentProjectEntry[]): RecentProjectEntry[] {
  return [...entries].sort((left, right) => right.lastOpenedAt - left.lastOpenedAt || left.filename.localeCompare(right.filename));
}

async function sameFileHandle(left: RecentProjectFileHandle, right: RecentProjectFileHandle): Promise<boolean> {
  try {
    if (left.isSameEntry) return await left.isSameEntry(right);
    if (right.isSameEntry) return await right.isSameEntry(left);
  } catch {
    return false;
  }
  return false;
}

function indexedDbRecentProjectPersistence(): RecentProjectPersistence {
  return {
    readAll: async () => {
      const db = await openRecentProjectsDb();
      try {
        return await new Promise<RecentProjectEntry[]>((resolve, reject) => {
          const transaction = db.transaction(STORE_NAME, "readonly");
          const request = transaction.objectStore(STORE_NAME).getAll();
          request.onsuccess = () => resolve((request.result ?? []) as RecentProjectEntry[]);
          request.onerror = () => reject(recentStoreError(request.error, "read"));
        });
      } finally {
        db.close();
      }
    },
    replaceAll: async (entries) => {
      const db = await openRecentProjectsDb();
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(STORE_NAME, "readwrite");
          const store = transaction.objectStore(STORE_NAME);
          store.clear();
          for (const entry of entries) store.put(entry);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(recentStoreError(transaction.error, "write"));
          transaction.onabort = () => reject(recentStoreError(transaction.error, "write"));
        });
      } finally {
        db.close();
      }
    }
  };
}

function openRecentProjectsDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("Recent Projects is unavailable because browser storage is disabled."));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(recentStoreError(request.error, "open"));
    request.onblocked = () => reject(new Error("Recent Projects storage is blocked by another tab."));
  });
}

function recentStoreError(error: DOMException | null, action: "open" | "read" | "write"): Error {
  return new Error(`Recent Projects storage ${action} failed${error?.message ? `: ${error.message}` : "."}`);
}

function createRecentProjectId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `recent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function errorName(error: unknown): string | undefined {
  return error && typeof error === "object" && "name" in error && typeof error.name === "string" ? error.name : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
