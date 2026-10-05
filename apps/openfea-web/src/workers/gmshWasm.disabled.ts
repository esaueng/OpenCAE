// Build-time stub for @loumalouomega/gmsh-wasm, swapped in by vite.config.ts
// when VITE_WASM_MESHING is off. The real package's Emscripten glue references
// gmsh-core.wasm via new URL(..., import.meta.url), which makes vite emit the
// ~44 MB asset as soon as the module is transformed — even when every import
// path to it is statically dead. See stubMeshWorkerClientWhenDisabled.
export async function initialize(): Promise<never> {
  throw new Error("gmsh-wasm is excluded from this build (VITE_WASM_MESHING=0 opt-out). Rebuild without the opt-out to enable in-browser meshing.");
}

export default initialize;
