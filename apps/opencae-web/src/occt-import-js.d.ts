declare module "occt-import-js" {
  export interface OcctImportOptions {
    locateFile?: (path: string) => string;
  }

  /** Inclusive triangle range of one B-rep face within the mesh's index buffer. */
  export interface OcctBrepFace {
    first: number;
    last: number;
    color: [number, number, number] | null;
  }

  export interface OcctMesh {
    name?: string;
    color?: [number, number, number];
    attributes?: {
      position?: { array: ArrayLike<number> };
      normal?: { array: ArrayLike<number> };
    };
    index?: { array: ArrayLike<number> };
    /** Per-face triangle ranges (present in occt-import-js >= 0.0.12). */
    brep_faces?: OcctBrepFace[];
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
