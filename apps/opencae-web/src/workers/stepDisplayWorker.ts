/// <reference lib="webworker" />

import occtimportjs from "occt-import-js";
import occtWasmUrl from "occt-import-js/dist/occt-import-js.wasm?url";
import { readStepFileForDisplay, type StepDisplayLod } from "../stepDisplayTessellation";

const MAX_STEP_DISPLAY_MESHES = 10_000;
const MAX_STEP_DISPLAY_FACES = 20_000;
const MAX_STEP_DISPLAY_POSITION_COMPONENTS = 3_000_000;
const MAX_STEP_DISPLAY_INDICES = 3_000_000;

type Request = { id: number; content: ArrayBuffer; lod: StepDisplayLod };

self.onmessage = async (event: MessageEvent<Request>) => {
  const { id, content, lod } = event.data;
  try {
    const importer = await occtimportjs({ locateFile: (path) => path.endsWith(".wasm") ? occtWasmUrl : path });
    const result = readStepFileForDisplay(importer, new Uint8Array(content), lod);
    const meshes = result.meshes ?? [];
    if (meshes.length > MAX_STEP_DISPLAY_MESHES) throw new Error("STEP display mesh limit exceeded.");
    let positionComponents = 0;
    let indexCount = 0;
    let faceCount = 0;
    const serialized = meshes.map((mesh) => {
      const positions = Float32Array.from(mesh.attributes?.position?.array ?? []);
      const normals = Float32Array.from(mesh.attributes?.normal?.array ?? []);
      const indices = Uint32Array.from(mesh.index?.array ?? []);
      const faces = (mesh.brep_faces ?? []).map((face) => ({ first: face.first, last: face.last, color: face.color ?? null }));
      positionComponents += positions.length;
      indexCount += indices.length;
      faceCount += faces.length;
      if (positionComponents > MAX_STEP_DISPLAY_POSITION_COMPONENTS || indexCount > MAX_STEP_DISPLAY_INDICES || faceCount > MAX_STEP_DISPLAY_FACES) {
        throw new Error("STEP display tessellation exceeds the browser preview limit.");
      }
      return { name: typeof (mesh as { name?: unknown }).name === "string" ? (mesh as { name: string }).name : undefined, positions, normals, indices, faces };
    });
    const transfer = serialized.flatMap((mesh) => [mesh.positions.buffer, mesh.normals.buffer, mesh.indices.buffer]);
    self.postMessage({ id, ok: true, success: result.success, errorCode: result.errorCode, meshes: serialized }, transfer);
  } catch (error) {
    self.postMessage({ id, ok: false, message: error instanceof Error ? error.message : "STEP display import failed." });
  }
};

export {};
