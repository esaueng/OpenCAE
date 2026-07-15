import { configureGmshWasmModuleOptions } from "@opencae/mesh-intake";
import type { OcctImportOptions } from "occt-import-js";
import occtWasmUrl from "occt-import-js/dist/occt-import-js.wasm?url";
import { gmshWasmModuleOptions } from "../workers/gmshWasmBinary";

type ConfigureGmshWasm = typeof configureGmshWasmModuleOptions;

/** Install the same compressed production Gmsh loader used by the mesh worker. */
export function configureValidationGmshWasm(
  configure: ConfigureGmshWasm = configureGmshWasmModuleOptions
): void {
  configure(gmshWasmModuleOptions);
}

/** Resolve OCCT's default wasm filename to Vite's emitted, content-hashed asset. */
export function validationOcctImportOptions(wasmUrl = occtWasmUrl): OcctImportOptions {
  return {
    locateFile: (path: string) => (path.endsWith(".wasm") ? wasmUrl : path)
  };
}
