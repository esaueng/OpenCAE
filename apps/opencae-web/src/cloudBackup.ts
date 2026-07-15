import type { AutosavedWorkspace } from "./appPersistence";
import { getBrowserStorage, readStorageItem, type StorageLike } from "./autosaveStorage";

const CLOUD_BACKUP_STORAGE_KEY = "opencae.workspace.cloud-backup.v1";
const CLOUD_BACKUP_PREFERENCE_STORAGE_KEY = "opencae.workspace.cloud-backup.preference.v1";
const CLOUD_BACKUP_PATH = "/api/project-backups";

export type CloudBackupPreference = "cloud" | "local";

export interface CloudBackupDescriptor {
  version: 1;
  backupId: string;
  runId: string;
  token: string;
  encryptionKey: string;
  expiresAt: string;
}

export async function saveEncryptedCloudBackup(
  snapshot: AutosavedWorkspace,
  runId: string,
  options: { fetch?: typeof fetch; storage?: StorageLike | null } = {}
): Promise<CloudBackupDescriptor> {
  const fetchImpl = options.fetch ?? fetch;
  const storage = options.storage ?? getBrowserStorage();
  const backupId = crypto.randomUUID();
  const token = randomBase64Url(32);
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const rawKey = await crypto.subtle.exportKey("raw", key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(snapshot));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  const encrypted = new Blob([iv, ciphertext], { type: "application/octet-stream" });
  const response = await fetchImpl(`${CLOUD_BACKUP_PATH}/${backupId}`, {
    method: "PUT",
    headers: {
      "content-type": "application/octet-stream",
      "x-opencae-backup-token": token,
      "x-opencae-run-id": runId
    },
    body: encrypted
  });
  if (!response.ok) throw new Error(await cloudBackupError(response, "Cloud backup could not be stored."));
  const result = await response.json() as { expiresAt?: unknown };
  if (typeof result.expiresAt !== "string") throw new Error("Cloud backup response did not include its retention date.");
  const descriptor: CloudBackupDescriptor = {
    version: 1,
    backupId,
    runId,
    token,
    encryptionKey: bytesToBase64Url(new Uint8Array(rawKey)),
    expiresAt: result.expiresAt
  };
  if (!writeDescriptor(descriptor, storage)) throw new Error("Cloud backup was stored, but its local recovery key could not be saved. Download the project file now.");
  return descriptor;
}

export async function restoreEncryptedCloudBackup(
  runId: string,
  options: { fetch?: typeof fetch; storage?: StorageLike | null } = {}
): Promise<AutosavedWorkspace | null> {
  const descriptor = readCloudBackupDescriptor(options.storage ?? getBrowserStorage());
  if (!descriptor || descriptor.runId !== runId || Date.parse(descriptor.expiresAt) <= Date.now()) return null;
  const response = await (options.fetch ?? fetch)(`${CLOUD_BACKUP_PATH}/${descriptor.backupId}`, {
    headers: { "x-opencae-backup-token": descriptor.token }
  });
  if (response.status === 404 || response.status === 410) return null;
  if (!response.ok) throw new Error(await cloudBackupError(response, "Cloud backup could not be restored."));
  const encrypted = new Uint8Array(await response.arrayBuffer());
  if (encrypted.byteLength <= 12) throw new Error("Cloud backup payload is invalid.");
  const key = await crypto.subtle.importKey("raw", base64UrlToBytes(descriptor.encryptionKey), { name: "AES-GCM" }, false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: encrypted.slice(0, 12) }, key, encrypted.slice(12));
  return JSON.parse(new TextDecoder().decode(plaintext)) as AutosavedWorkspace;
}

export async function requestPersistentBrowserStorage(): Promise<boolean | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return null;
  return navigator.storage.persist();
}

export function readCloudBackupDescriptor(storage = getBrowserStorage()): CloudBackupDescriptor | null {
  const payload = readStorageItem(storage, CLOUD_BACKUP_STORAGE_KEY);
  if (!payload) return null;
  try {
    const value = JSON.parse(payload) as Partial<CloudBackupDescriptor>;
    return value.version === 1 && typeof value.backupId === "string" && typeof value.runId === "string" &&
      typeof value.token === "string" && typeof value.encryptionKey === "string" && typeof value.expiresAt === "string"
      ? value as CloudBackupDescriptor
      : null;
  } catch {
    return null;
  }
}

export function readCloudBackupPreference(storage = getBrowserStorage()): CloudBackupPreference | null {
  const preference = readStorageItem(storage, CLOUD_BACKUP_PREFERENCE_STORAGE_KEY);
  return preference === "cloud" || preference === "local" ? preference : null;
}

export function writeCloudBackupPreference(preference: CloudBackupPreference, storage = getBrowserStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(CLOUD_BACKUP_PREFERENCE_STORAGE_KEY, preference);
    return true;
  } catch {
    return false;
  }
}

function writeDescriptor(descriptor: CloudBackupDescriptor, storage: StorageLike | null): boolean {
  if (!storage) return false;
  try {
    storage.setItem(CLOUD_BACKUP_STORAGE_KEY, JSON.stringify(descriptor));
    return true;
  } catch {
    return false;
  }
}

function randomBase64Url(length: number): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(length)));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function cloudBackupError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    return typeof body.error === "string" ? body.error : fallback;
  } catch {
    return fallback;
  }
}
