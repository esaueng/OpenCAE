// Browser proof harness for the gmsh-wasm meshing worker (plan A-M2).
// Loaded (dynamically) from main.tsx only when VITE_WASM_MESHING=1, so default
// builds carry none of this. It exposes window.__opencaeMeshProof so a headless
// browser can drive a real end-to-end mesh (worker -> gmsh-wasm -> parser ->
// packed transfer -> core model build) and read structured evidence back.
import {
  bracketGeoScript,
  bracketGeometrySourceMetadata,
  buildCoreModelFromCloudMesh,
  type BracketGeometryDescriptor
} from "@opencae/mesh-intake";
import { unpackCoreVolumeMeshArtifact, type MeshWorkerPhase } from "./meshProtocol";
import { meshGeoScriptInWorker } from "./meshWorkerClient";

export type MeshProofResult = {
  ok: true;
  nodeCount: number;
  elementCount: number;
  elementType: string;
  surfaceFacetCount: number;
  connectedComponentCount: number;
  invertedElementCount: number;
  surfaceSetNames: string[];
  phases: Array<{ phase: MeshWorkerPhase; elapsedMs: number }>;
  totalMs: number;
  coreModel: {
    schema: string;
    nodeCount: number;
    elementBlockTypes: string[];
    boundaryConditionCount: number;
    loadCount: number;
    meshSource: string | undefined;
  };
} | { ok: false; error: string };

async function runBracketProof(options: { elementOrder?: 1 | 2; descriptor?: BracketGeometryDescriptor } = {}): Promise<MeshProofResult> {
  try {
    const phases: Array<{ phase: MeshWorkerPhase; elapsedMs: number }> = [];
    const geoScript = bracketGeoScript(options.descriptor ?? {});
    const meshed = await meshGeoScriptInWorker(
      {
        geoScript,
        elementOrder: options.elementOrder ?? 2,
        units: "mm",
        sourceSelectionRefs: bracketGeometrySourceMetadata()
      },
      (progress) => phases.push({ phase: progress.phase, elapsedMs: Math.round(progress.elapsedMs) })
    );
    const artifact = unpackCoreVolumeMeshArtifact(meshed.packed);
    const coreModel = buildCoreModelFromCloudMesh({
      volumeMesh: artifact,
      analysisType: "static_stress",
      solverSettings: { elementOrder: options.elementOrder ?? 2 }
    });
    return {
      ok: true,
      nodeCount: artifact.metadata.nodeCount,
      elementCount: artifact.metadata.elementCount,
      elementType: artifact.elements[0]?.type ?? "none",
      surfaceFacetCount: artifact.metadata.surfaceFacetCount,
      connectedComponentCount: artifact.metadata.connectedComponentCount,
      invertedElementCount: artifact.metadata.meshQuality.invertedElementCount,
      surfaceSetNames: artifact.surfaceSets.map((set) => set.name),
      phases,
      totalMs: Math.round(meshed.totalMs),
      coreModel: {
        schema: coreModel.schema,
        nodeCount: coreModel.nodes.coordinates.length / 3,
        elementBlockTypes: coreModel.elementBlocks.map((block) => block.type),
        boundaryConditionCount: coreModel.boundaryConditions.length,
        loadCount: coreModel.loads.length,
        meshSource: coreModel.meshProvenance?.meshSource
      }
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error) };
  }
}

declare global {
  interface Window {
    __opencaeMeshProof?: {
      runBracket: typeof runBracketProof;
      /** Set once an auto-run (triggered by ?meshProof=1) finishes. */
      lastResult?: MeshProofResult;
    };
  }
}

window.__opencaeMeshProof = { runBracket: runBracketProof };

// ?meshProof=1 auto-runs the bracket proof and mirrors the outcome into
// document.title + console so dump-dom style headless capture works too.
if (new URLSearchParams(window.location.search).get("meshProof") === "1") {
  void runBracketProof().then((result) => {
    window.__opencaeMeshProof!.lastResult = result;
    const title = result.ok
      ? `MESHPROOF OK nodes=${result.nodeCount} elements=${result.elementCount} type=${result.elementType} totalMs=${result.totalMs}`
      : `MESHPROOF FAIL ${result.error.split("\n")[0]}`;
    document.title = title;
    console.log(`[meshProof] ${title}`, result);
  });
}
