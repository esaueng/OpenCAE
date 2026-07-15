import { describe, expect, test, vi } from "vitest";
import { gmshWasmModuleOptions } from "../workers/gmshWasmBinary";
import {
  configureValidationGmshWasm,
  validationOcctImportOptions
} from "./validationWasmRuntime";

describe("validation WASM runtime", () => {
  test("installs the compressed production Gmsh loader", () => {
    const configure = vi.fn();

    configureValidationGmshWasm(configure);

    expect(configure).toHaveBeenCalledOnce();
    expect(configure).toHaveBeenCalledWith(gmshWasmModuleOptions);
  });

  test("routes OCCT wasm requests to Vite's emitted asset", () => {
    const options = validationOcctImportOptions("/assets/occt-import-js-test.wasm");

    expect(options.locateFile?.("occt-import-js.wasm")).toBe("/assets/occt-import-js-test.wasm");
    expect(options.locateFile?.("support.data")).toBe("support.data");
  });
});
