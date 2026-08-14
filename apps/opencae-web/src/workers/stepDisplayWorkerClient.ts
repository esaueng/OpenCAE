import type { OcctImportResult, OcctMesh } from "occt-import-js";
import { MAX_EMBEDDED_MODEL_BYTES } from "@opencae/schema";
import type { StepDisplayLod } from "../stepDisplayTessellation";

const STEP_DISPLAY_TIMEOUT_MS = 20_000;
let requestId = 0;

type WorkerResponse = {
  id: number;
  ok: boolean;
  success?: boolean;
  errorCode?: number;
  message?: string;
  meshes?: Array<{
    name?: string;
    positions: Float32Array;
    normals: Float32Array;
    indices: Uint32Array;
    faces: Array<{ first: number; last: number; color: null }>;
  }>;
};

export async function readStepFileInDisplayWorker(content: Uint8Array, lod: StepDisplayLod = "detailed"): Promise<OcctImportResult> {
  if (content.byteLength <= 0 || content.byteLength > MAX_EMBEDDED_MODEL_BYTES) {
    throw new Error("STEP display input exceeds the 32 MiB browser limit.");
  }
  const worker = new Worker(new URL("./stepDisplayWorker.ts", import.meta.url), { type: "module" });
  const id = ++requestId;
  return new Promise<OcctImportResult>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      worker.terminate();
      reject(new Error("STEP display import exceeded the 20 second browser limit."));
    }, STEP_DISPLAY_TIMEOUT_MS);
    const finish = () => {
      globalThis.clearTimeout(timer);
      worker.terminate();
    };
    worker.onerror = () => {
      finish();
      reject(new Error("STEP display worker failed."));
    };
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.id !== id) return;
      finish();
      if (!event.data.ok) {
        reject(new Error(event.data.message ?? "STEP display import failed."));
        return;
      }
      const meshes: OcctMesh[] = (event.data.meshes ?? []).map((mesh) => ({
        ...(mesh.name ? { name: mesh.name } : {}),
        attributes: {
          position: { array: mesh.positions },
          ...(mesh.normals.length ? { normal: { array: mesh.normals } } : {})
        },
        index: { array: mesh.indices },
        brep_faces: mesh.faces
      }));
      resolve({ success: event.data.success === true, ...(event.data.errorCode ? { errorCode: event.data.errorCode } : {}), meshes });
    };
    const transferred = content.slice().buffer as ArrayBuffer;
    worker.postMessage({ id, content: transferred, lod }, [transferred]);
  });
}
