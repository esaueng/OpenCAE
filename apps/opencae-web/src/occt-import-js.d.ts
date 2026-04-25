declare module "occt-import-js" {
  export interface OcctImportOptions {
    locateFile?: (path: string) => string;
  }

  export interface OcctMesh {
    name?: string;
    color?: [number, number, number];
    attributes?: {
      position?: { array: ArrayLike<number> };
      normal?: { array: ArrayLike<number> };
    };
    index?: { array: ArrayLike<number> };
  }

  export interface OcctImportResult {
    success: boolean;
    errorCode?: number;
    meshes?: OcctMesh[];
  }

  export interface OcctImporter {
    ReadStepFile(buffer: Uint8Array, params: unknown): OcctImportResult;
  }

  export default function occtimportjs(options?: OcctImportOptions): Promise<OcctImporter>;
}

declare module "occt-import-js/dist/occt-import-js.wasm?url" {
  const url: string;
  export default url;
}
