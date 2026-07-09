// In-browser gmsh-wasm mesh generation for the app's mesh step (plan A-M2,
// production default since A-M4). generateWasmMeshForStudy returns null in
// VITE_WASM_MESHING=0 opt-out builds, when workers are unavailable, or when
// the study's geometry has no wasm-meshable source, and generateMesh() then
// falls back to the existing preset-estimate path.
//
// The heavyweight pieces (@opencae/mesh-intake and, transitively, the gmsh
// WASM module inside the worker) are loaded via dynamic import only after the
// flag check passes, so default builds and the initial bundle stay untouched.
import type { DisplayModel, MeshQuality, Study } from "@opencae/schema";
import { inferGlobalCriticalPrintAxis } from "@opencae/study-core";
import { geometrySourceForStudy, studyForCoreGeometryDispatch, type CoreCloudGeometrySource } from "../workers/opencaeCoreSolve";
import { unpackCoreVolumeMeshArtifact } from "../workers/meshProtocol";
import type { MeshProgressListener } from "../workers/meshWorkerClient";

/**
 * Can this study's geometry be meshed on demand, in this build and browser?
 * Mirrors exactly what meshWorkerRun below can mesh: the procedural bracket
 * and STEP uploads. Used by run routing (A-M4 local-first): complex geometry
 * without a stored mesh artifact is still runnable locally when this is true,
 * because the run flow meshes first and then solves.
 */
export function canMeshStudyOnDemand(study: Study, displayModel?: DisplayModel): boolean {
  if (import.meta.env.VITE_WASM_MESHING === "0") return false;
  if (typeof Worker === "undefined") return false;
  const geometry = geometrySourceForStudy(study, displayModel);
  if (!geometry) return false;
  if (geometry.kind === "sample_procedural" && geometry.sampleId === "bracket") return true;
  return geometry.kind === "uploaded_cad" && geometry.format === "step" && Boolean(geometry.contentBase64);
}

// The worker client is loaded via dynamic import behind the statically
// replaced VITE_WASM_MESHING check below. This matters for deploys: the
// client statically references meshWorker.ts (new Worker(new URL(...))),
// which makes vite emit the worker chunk plus the ~44 MB gmsh-core.wasm
// asset — flag-off builds must not carry those (Cloudflare static assets
// cap out at 25 MiB per file).
type MeshWorkerClientModule = typeof import("../workers/meshWorkerClient");
let workerClient: MeshWorkerClientModule | null = null;

/** Hard-cancel any in-flight in-browser meshing (terminates the worker). No-op when idle. */
export function cancelWasmMeshing(reason?: string): void {
  workerClient?.cancelMeshWork(reason);
}

const MESH_PHASE_MESSAGES: Record<string, string> = {
  load: "Loading gmsh WebAssembly module...",
  init: "Starting in-browser mesher...",
  import: "Importing geometry into gmsh...",
  mesh2d: "Meshing surfaces...",
  mesh3d: "Meshing volume...",
  order2: "Elevating mesh to quadratic (Tet10) elements...",
  write: "Writing mesh...",
  parse: "Building Core volume mesh artifact..."
};

export type WasmMeshStudyResult = { study: Study; message: string } | null;

/**
 * Mesh the study's geometry with gmsh-wasm in a worker, build the Core model
 * with the mirrored cloud builder, and return an updated study whose
 * meshSettings.summary carries real counts plus the actualCoreModel artifact
 * that @opencae/core-adapter's actualCoreVolumeMeshArtifact() consumes.
 */
export async function generateWasmMeshForStudy(options: WasmMeshOptions): Promise<WasmMeshStudyResult> {
  // The dynamic imports live inside this statically replaced branch so
  // flag-off builds tree-shake meshWorkerRun entirely — rollup only prunes
  // the worker chunk when the import() call sites themselves become
  // unreachable (an early-return guard is not enough). Default is ON (plan
  // A-M4); only an explicit VITE_WASM_MESHING=0 opt-out build disables it.
  if (import.meta.env.VITE_WASM_MESHING !== "0") {
    return meshWorkerRun(options);
  }
  return null;
}

type WasmMeshOptions = {
  preset: MeshQuality;
  study: Study;
  displayModel?: DisplayModel;
  /** Preset-sized geometry source (api.ts applies the cloud meshSize override). */
  geometry: CoreCloudGeometrySource | null;
  /** Characteristic length for STEP uploads (mm), mirroring the cloud preset map. */
  meshSizeMm?: number;
  onProgress?: (message: string) => void;
};

async function meshWorkerRun(options: WasmMeshOptions): Promise<WasmMeshStudyResult> {
  const { preset, study, displayModel, geometry } = options;
  if (typeof Worker === "undefined" || !geometry) return null;

  const onWorkerProgress: MeshProgressListener = ({ phase }) => {
    const message = MESH_PHASE_MESSAGES[phase];
    if (message) options.onProgress?.(message);
  };

  const [client, intake] = await Promise.all([
    import("../workers/meshWorkerClient"),
    import("@opencae/mesh-intake")
  ]);
  workerClient = client;
  let meshedPacked: Awaited<ReturnType<MeshWorkerClientModule["meshGeoScriptInWorker"]>>;
  let elementOrder: 1 | 2;
  let algorithmNote: string | undefined;
  let elevationNote: string | undefined;
  let refinementNote: string | undefined;
  let attributionNote: string | undefined;

  if (geometry.kind === "sample_procedural" && geometry.sampleId === "bracket") {
    // Native curved Gmsh Tet10 elements can invert around the bracket's
    // drilled holes, so the bracket meshes with linear elements (the same
    // policy the retired cloud dispatch used).
    elementOrder = 1;
    meshedPacked = await client.meshGeoScriptInWorker(
      {
        geoScript: intake.bracketGeoScript(geometry.descriptor ?? {}),
        elementOrder,
        units: geometry.units ?? "mm",
        sourceSelectionRefs: intake.bracketGeometrySourceMetadata()
      },
      onWorkerProgress
    );
  } else if (geometry.kind === "uploaded_cad" && geometry.format === "step" && geometry.contentBase64) {
    elementOrder = intake.requestedElementOrder(study.solverSettings as Record<string, unknown> | undefined);
    // A-M3: send the STEP display tessellation + faceIds so the worker can
    // stamp every boundary facet's sourceFaceId (facet -> B-rep face
    // attribution). Meshing proceeds without it if the registry fails.
    let attribution: import("@opencae/mesh-intake").StepAttributionTessellation | undefined;
    try {
      const stepFaces = await import("../stepFaces");
      const registry = await stepFaces.stepFaceRegistryFromBase64(geometry.contentBase64);
      attribution = stepFaces.stepAttributionForRegistry(registry);
    } catch {
      attribution = undefined;
    }
    const stepResult = await client.meshStepFileInWorker(
      {
        stepContent: base64ToArrayBuffer(geometry.contentBase64),
        elementOrder,
        units: geometry.units ?? "mm",
        meshSizeMm: options.meshSizeMm,
        attribution
      },
      onWorkerProgress
    );
    meshedPacked = stepResult;
    if (stepResult.algorithm3D === "frontal") {
      algorithmNote = "Delaunay 3D meshing failed in the browser mesher; the Frontal algorithm produced this mesh.";
    }
    if (stepResult.elevation === "straight_edge") {
      elevationNote = "Curved Tet10 elevation produced near-degenerate elements on this geometry; mid-side nodes were placed on straight edges instead (slightly less accurate on curved boundaries).";
    }
    if (stepResult.qualityRefinement) {
      const { requestedMeshSizeMm, usedMeshSizeMm } = stepResult.qualityRefinement;
      refinementNote = `Mesh quality at the ${formatMeshSizeMm(requestedMeshSizeMm)} mm preset size missed the quality floor on this geometry; the mesh was automatically refined to ${formatMeshSizeMm(usedMeshSizeMm)} mm.`;
    }
    if (!attribution) {
      attributionNote = "STEP face registry unavailable; selections fall back to geometric matching.";
    }
  } else {
    // Structured blocks and the cantilever/beam samples keep their existing
    // paths; other sources are not wasm-meshable yet.
    return null;
  }

  const artifact = unpackCoreVolumeMeshArtifact(meshedPacked.packed);
  const analysisType = study.type === "dynamic_structural" ? "dynamic_structural" : "static_stress";
  // The mirrored builder applies study load directions verbatim in the solver
  // frame (same contract as the cloud container), so hand it a solver-frame study.
  const dispatchStudy = studyForCoreGeometryDispatch(study, displayModel);
  const criticalLayerAxis = inferGlobalCriticalPrintAxis(study, (displayModel?.faces ?? []).map((face) => ({
    entityId: face.id,
    center: face.center,
    ...(face.area ? { areaM2: face.area * 1e-6 } : {})
  })), displayModel);
  const mappingDiagnostics: import("@opencae/mesh-intake").SelectionMappingDiagnostic[] = [];
  const model = intake.buildCoreModelFromCloudMesh({
    study: {
      id: dispatchStudy.id,
      type: analysisType,
      materialAssignments: dispatchStudy.materialAssignments,
      namedSelections: dispatchStudy.namedSelections,
      constraints: dispatchStudy.constraints,
      loads: dispatchStudy.loads,
      solverSettings: dispatchStudy.solverSettings as Record<string, unknown> | undefined
    },
    displayModel,
    volumeMesh: artifact,
    analysisType,
    solverSettings: { ...(study.solverSettings as Record<string, unknown> | undefined ?? {}), elementOrder },
    criticalLayerAxis,
    mappingDiagnostics
  });

  const nodes = artifact.metadata.nodeCount;
  const elements = artifact.metadata.elementCount;
  const elementType = artifact.elements[0]?.type ?? "Tet4";
  const summary: NonNullable<Study["meshSettings"]["summary"]> = {
    nodes,
    elements,
    warnings: [algorithmNote, elevationNote, refinementNote, attributionNote].filter((note): note is string => Boolean(note)),
    quality: preset,
    source: "wasm_gmsh",
    units: "m",
    solverCoordinateSpace: "solver",
    artifacts: {
      actualCoreModel: { model },
      meshConnectivity: { connectedComponents: artifact.metadata.connectedComponentCount },
      // A-M3 diagnostics: which mapSelectionToSurfaceSet branch resolved each
      // selection. For STEP uploads with a healthy face registry this must be
      // bySelection/byFace — never the geometric fallback.
      ...(mappingDiagnostics.length ? { selectionMapping: mappingDiagnostics } : {})
    }
  };

  return {
    study: {
      ...study,
      meshSettings: {
        preset,
        status: "complete",
        meshRef: `${study.projectId}/mesh/wasm-gmsh-mesh.json`,
        summary
      }
    },
    message: `Mesh generated in browser (gmsh-wasm): ${nodes.toLocaleString()} nodes, ${elements.toLocaleString()} ${elementType} elements.`
  };
}

function formatMeshSizeMm(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function base64ToArrayBuffer(contentBase64: string): ArrayBuffer {
  const binary = atob(contentBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}
