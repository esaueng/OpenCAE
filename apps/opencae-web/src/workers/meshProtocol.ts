// Typed protocol for the in-browser gmsh-wasm meshing worker (plan A-M1 spike).
// Mirrors the request/response conventions of performanceProtocol.ts and adds
// phase-based progress messages plus a transferable packed mesh artifact
// (Float64Array coordinates + Uint32Array connectivity + JSON metadata).
import type {
  CoreVolumeMeshArtifact,
  FacetAttributionReport,
  MeshPhase,
  MeshTimings,
  SourceSelectionMetadata,
  StepAttributionTessellation
} from "@opencae/mesh-intake";

export type MeshWorkerPhase = MeshPhase | "parse";

export type MeshWorkerPayloads = {
  meshGeoScript: {
    geoScript: string;
    elementOrder?: 1 | 2;
    units?: "mm" | "m";
    sourceSelectionRefs?: Record<string, SourceSelectionMetadata>;
  };
  meshStepFile: {
    /** UTF-8 encoded STEP file content (transferable). */
    stepContent: ArrayBuffer;
    elementOrder?: 1 | 2;
    units?: "mm" | "m";
    meshSizeMm?: number;
    /**
     * STEP display tessellation + faceIds (plan A-M3): when present, the
     * worker stamps every boundary facet's sourceFaceId per surface set so
     * selection mapping resolves via byFace instead of the geometric
     * fallback. Typed-array buffers travel as transferables.
     */
    attribution?: StepAttributionTessellation;
  };
};

/**
 * The mesh crosses the worker boundary as two transferable typed arrays plus a
 * JSON string for everything irregular (surface facets/sets, metadata). The
 * gmsh-wasm pipeline always produces a single element type per mesh.
 */
export type PackedCoreVolumeMeshArtifact = {
  coordinates: Float64Array;
  connectivity: Uint32Array;
  elementType: "Tet4" | "Tet10";
  nodesPerElement: 4 | 10;
  /** JSON of PackedArtifactMetadata. */
  metadataJson: string;
};

export type PackedArtifactMetadata = {
  elements: Array<Pick<CoreVolumeMeshArtifact["elements"][number], "material" | "physicalName">>;
  surfaceFacets: CoreVolumeMeshArtifact["surfaceFacets"];
  surfaceSets: CoreVolumeMeshArtifact["surfaceSets"];
  coordinateSystem: CoreVolumeMeshArtifact["coordinateSystem"];
  metadata: CoreVolumeMeshArtifact["metadata"];
};

export type MeshWorkerResults = {
  meshGeoScript: {
    packed: PackedCoreVolumeMeshArtifact;
    timings: MeshTimings;
    totalMs: number;
  };
  meshStepFile: {
    packed: PackedCoreVolumeMeshArtifact;
    timings: MeshTimings;
    totalMs: number;
    algorithm3D: "delaunay" | "frontal";
    /** Facet->B-rep-face attribution report (present when the request carried attribution inputs). */
    attribution?: FacetAttributionReport;
  };
};

export type MeshWorkerOperation = keyof MeshWorkerPayloads;

export type MeshWorkerRequest<Operation extends MeshWorkerOperation = MeshWorkerOperation> = {
  [Key in MeshWorkerOperation]: {
    id: string;
    operation: Key;
    payload: MeshWorkerPayloads[Key];
  };
}[Operation];

export interface MeshWorkerError {
  name: string;
  message: string;
  stack?: string;
}

export type MeshWorkerProgress = {
  id: string;
  operation: MeshWorkerOperation;
  kind: "progress";
  phase: MeshWorkerPhase;
  elapsedMs: number;
};

export type MeshWorkerSuccess<Operation extends MeshWorkerOperation = MeshWorkerOperation> = {
  [Key in MeshWorkerOperation]: {
    id: string;
    operation: Key;
    ok: true;
    result: MeshWorkerResults[Key];
  };
}[Operation];

export type MeshWorkerFailure<Operation extends MeshWorkerOperation = MeshWorkerOperation> = {
  id: string;
  operation: Operation;
  ok: false;
  error: MeshWorkerError;
};

export type MeshWorkerResponse<Operation extends MeshWorkerOperation = MeshWorkerOperation> =
  | MeshWorkerSuccess<Operation>
  | MeshWorkerFailure<Operation>
  | MeshWorkerProgress;

let requestCounter = 0;

export function createMeshWorkerRequest<Operation extends MeshWorkerOperation>(
  operation: Operation,
  payload: MeshWorkerPayloads[Operation]
): MeshWorkerRequest<Operation> {
  requestCounter += 1;
  const uniquePart = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${requestCounter.toString(36)}`;
  return {
    id: `mesh-${uniquePart}`,
    operation,
    payload
  } as MeshWorkerRequest<Operation>;
}

export function isMeshWorkerProgress(value: unknown): value is MeshWorkerProgress {
  return isRecord(value) && value.kind === "progress" && typeof value.id === "string" && typeof value.phase === "string";
}

export function isMeshWorkerSuccess(value: unknown): value is MeshWorkerSuccess {
  return isRecord(value) && value.ok === true && typeof value.id === "string" && typeof value.operation === "string" && "result" in value;
}

export function isMeshWorkerFailure(value: unknown): value is MeshWorkerFailure {
  return isRecord(value) && value.ok === false && typeof value.id === "string" && typeof value.operation === "string" && isRecord(value.error) && typeof value.error.message === "string";
}

export function normalizeMeshWorkerError(error: unknown): MeshWorkerError {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message || "Mesh worker operation failed.",
      ...(error.stack ? { stack: error.stack } : {})
    };
  }
  return {
    name: "Error",
    message: typeof error === "string" ? error : "Mesh worker operation failed."
  };
}

export function packCoreVolumeMeshArtifact(artifact: CoreVolumeMeshArtifact): PackedCoreVolumeMeshArtifact {
  const first = artifact.elements[0];
  if (!first) throw new Error("Cannot pack an empty volume mesh artifact.");
  const elementType = first.type;
  if (elementType !== "Tet4" && elementType !== "Tet10") {
    throw new Error(`Cannot pack volume mesh with element type ${elementType}.`);
  }
  const nodesPerElement = elementType === "Tet10" ? 10 : 4;
  const connectivity = new Uint32Array(artifact.elements.length * nodesPerElement);
  artifact.elements.forEach((element, index) => {
    if (element.type !== elementType) {
      throw new Error(`Cannot pack mixed element types (${elementType} and ${element.type}).`);
    }
    connectivity.set(element.connectivity, index * nodesPerElement);
  });
  const metadata: PackedArtifactMetadata = {
    elements: artifact.elements.map((element) => ({ material: element.material, physicalName: element.physicalName })),
    surfaceFacets: artifact.surfaceFacets,
    surfaceSets: artifact.surfaceSets,
    coordinateSystem: artifact.coordinateSystem,
    metadata: artifact.metadata
  };
  return {
    coordinates: Float64Array.from(artifact.nodes.coordinates),
    connectivity,
    elementType,
    nodesPerElement,
    metadataJson: JSON.stringify(metadata)
  };
}

export function unpackCoreVolumeMeshArtifact(packed: PackedCoreVolumeMeshArtifact): CoreVolumeMeshArtifact {
  const metadata = JSON.parse(packed.metadataJson) as PackedArtifactMetadata;
  const elementCount = packed.connectivity.length / packed.nodesPerElement;
  const elements: CoreVolumeMeshArtifact["elements"] = [];
  for (let index = 0; index < elementCount; index += 1) {
    const start = index * packed.nodesPerElement;
    const extra = metadata.elements[index] ?? {};
    elements.push({
      type: packed.elementType,
      connectivity: Array.from(packed.connectivity.subarray(start, start + packed.nodesPerElement)),
      ...(extra.material !== undefined ? { material: extra.material } : {}),
      ...(extra.physicalName !== undefined ? { physicalName: extra.physicalName } : {})
    });
  }
  return {
    nodes: { coordinates: Array.from(packed.coordinates) },
    elements,
    surfaceFacets: metadata.surfaceFacets,
    surfaceSets: metadata.surfaceSets,
    coordinateSystem: metadata.coordinateSystem,
    metadata: metadata.metadata
  };
}

export function transferablesForMeshWorkerRequest(request: MeshWorkerRequest): Transferable[] {
  if (request.operation !== "meshStepFile") return [];
  const transfers: Transferable[] = [request.payload.stepContent];
  const attribution = request.payload.attribution;
  if (attribution) {
    transfers.push(attribution.positions.buffer, attribution.indices.buffer, attribution.triangleFaceIndex.buffer);
  }
  return transfers;
}

export function transferablesForMeshWorkerResult(result: unknown): Transferable[] {
  if (!isRecord(result) || !isRecord(result.packed)) return [];
  const packed = result.packed as Partial<PackedCoreVolumeMeshArtifact>;
  const transfers: Transferable[] = [];
  if (packed.coordinates instanceof Float64Array) transfers.push(packed.coordinates.buffer);
  if (packed.connectivity instanceof Uint32Array) transfers.push(packed.connectivity.buffer);
  return transfers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
