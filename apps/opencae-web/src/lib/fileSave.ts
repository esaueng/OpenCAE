import type { RecentProjectFileHandle } from "../recentProjects";

export interface SaveFilePickerHandle extends RecentProjectFileHandle {
  createWritable: () => Promise<{ write: (content: Blob) => Promise<void>; close: () => Promise<void> }>;
}

export interface SaveFilePickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<SaveFilePickerHandle>;
}

export interface SaveBlobOptions {
  description: string;
  accept: Record<string, string[]>;
}

export interface BlobSaveTarget {
  handle?: SaveFilePickerHandle;
  save: (blob: Blob) => Promise<"saved">;
}

export async function saveBlobToDisk(
  blob: Blob,
  suggestedName: string,
  options: SaveBlobOptions
): Promise<"saved" | "cancelled"> {
  const target = await prepareBlobSaveToDisk(suggestedName, options);
  if (target === "cancelled") return target;
  return target.save(blob);
}

export async function prepareBlobSaveToDisk(
  suggestedName: string,
  options: SaveBlobOptions
): Promise<BlobSaveTarget | "cancelled"> {
  const savePicker = (window as SaveFilePickerWindow).showSaveFilePicker;
  if (savePicker) {
    try {
      const handle = await savePicker({
        suggestedName,
        types: [{ description: options.description, accept: options.accept }]
      });
      return {
        handle,
        save: async (blob) => {
          const writable = await handle.createWritable();
          await writable.write(blob);
          await writable.close();
          return "saved";
        }
      };
    } catch (error) {
      if (isAbortError(error)) return "cancelled";
      return anchorSaveTarget(suggestedName);
    }
  }

  return anchorSaveTarget(suggestedName);
}

function anchorSaveTarget(suggestedName: string): BlobSaveTarget {
  return {
    save: async (blob) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = suggestedName;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      return "saved";
    }
  };
}

function isAbortError(error: unknown): boolean {
  return errorName(error) === "AbortError";
}

function errorName(error: unknown): string | undefined {
  return error && typeof error === "object" && "name" in error && typeof error.name === "string" ? error.name : undefined;
}
