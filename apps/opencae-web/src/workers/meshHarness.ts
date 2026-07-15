// Browser proof harness for the gmsh-wasm meshing worker (plan A-M2).
// Loaded (dynamically) from main.tsx by default since A-M4 (its own lazy
// chunk; VITE_WASM_MESHING=0 opt-out builds carry none of this). It exposes
// window.__opencaeMeshProof so a headless
// browser can drive a real end-to-end mesh (worker -> gmsh-wasm -> parser ->
// packed transfer -> core model build) and read structured evidence back.
import {
  bracketGeoScript,
  bracketGeometrySourceMetadata,
  buildCoreModelFromCloudMesh,
  type BracketGeometryDescriptor,
  type SelectionMappingDiagnostic
} from "@opencae/mesh-intake";
import { unpackCoreVolumeMeshArtifact, type MeshWorkerPhase } from "./meshProtocol";
import { meshGeoScriptInWorker, meshStepFileInWorker } from "./meshWorkerClient";
import { trySolveOpenCaeCoreStudy } from "@opencae/core-adapter";
import { stepAttributionForRegistry, stepFaceRegistryFromBase64 } from "../stepFaces";
import { STEP_PROOF_LOAD_NEWTONS, stepProofScenario, studyWithWasmMeshSummary } from "./stepProofScenario";
import { isModalResultSummary } from "@opencae/schema";
// The corpus STEP fixture ships inline in the (flag-on-only) harness chunk so
// the browser proof runs the real upload path without network fetches.
import boxWithBoreStep from "../../../../libs/opencae-mesh-intake/fixtures/box-with-bore.step?raw";

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

// A-M3: STEP path end-to-end in the browser — registry (occt WASM) -> face
// selections by real faceId -> mesh worker with attribution transferables ->
// Core model build (byFace mapping asserted via diagnostics) -> in-browser
// static solve with the reaction-vs-applied-load check.
export type StepProofResult = {
  ok: true;
  brepFaceCount: number;
  nodeCount: number;
  elementCount: number;
  elementType: string;
  surfaceFacetCount: number;
  connectedComponentCount: number;
  invertedElementCount: number;
  algorithm3D: "delaunay" | "frontal";
  attributedSets: number;
  totalSets: number;
  supportFaceId: string;
  loadFaceId: string;
  mappingModes: Array<{ role: string; mode: string; surfaceSet: string; matchedFacetCount: number }>;
  usedGeometricFallback: boolean;
  phases: Array<{ phase: MeshWorkerPhase; elapsedMs: number }>;
  totalMs: number;
  solve: {
    ok: boolean;
    solverBackend?: string;
    maxStress?: number;
    maxStressUnits?: string;
    maxDisplacement?: number;
    maxDisplacementUnits?: string;
    reactionForce?: number;
    appliedForce: number;
    reactionMatchesApplied?: boolean;
    reason?: string;
  };
} | { ok: false; error: string };

async function runStepProof(): Promise<StepProofResult> {
  try {
    const contentBase64 = btoa(boxWithBoreStep);
    const registry = await stepFaceRegistryFromBase64(contentBase64);
    const scenario = stepProofScenario(registry, { filename: "box-with-bore.step", contentBase64 });

    const phases: Array<{ phase: MeshWorkerPhase; elapsedMs: number }> = [];
    const stepBytes = new TextEncoder().encode(boxWithBoreStep);
    const stepContent = new ArrayBuffer(stepBytes.byteLength);
    new Uint8Array(stepContent).set(stepBytes);
    const meshed = await meshStepFileInWorker(
      {
        stepContent,
        elementOrder: 2,
        units: "mm",
        meshSizeMm: 6,
        attribution: stepAttributionForRegistry(registry)
      },
      (progress) => phases.push({ phase: progress.phase, elapsedMs: Math.round(progress.elapsedMs) })
    );
    const artifact = unpackCoreVolumeMeshArtifact(meshed.packed);
    const mappingDiagnostics: SelectionMappingDiagnostic[] = [];
    const model = buildCoreModelFromCloudMesh({
      study: {
        id: scenario.study.id,
        type: "static_stress",
        materialAssignments: scenario.study.materialAssignments,
        namedSelections: scenario.study.namedSelections,
        constraints: scenario.study.constraints,
        loads: scenario.study.loads,
        solverSettings: scenario.study.solverSettings as Record<string, unknown>
      },
      displayModel: scenario.displayModel,
      volumeMesh: artifact,
      analysisType: "static_stress",
      solverSettings: { elementOrder: 2 },
      mappingDiagnostics
    });

    const solvableStudy = studyWithWasmMeshSummary({ study: scenario.study, artifact, model, mappingDiagnostics });
    const outcome = trySolveOpenCaeCoreStudy({ study: solvableStudy, runId: "run-meshproof-step", displayModel: scenario.displayModel });
    const summary = outcome.ok && !isModalResultSummary(outcome.result.summary) ? outcome.result.summary : undefined;
    return {
      ok: true,
      brepFaceCount: registry.faces.length,
      nodeCount: artifact.metadata.nodeCount,
      elementCount: artifact.metadata.elementCount,
      elementType: artifact.elements[0]?.type ?? "none",
      surfaceFacetCount: artifact.metadata.surfaceFacetCount,
      connectedComponentCount: artifact.metadata.connectedComponentCount,
      invertedElementCount: artifact.metadata.meshQuality.invertedElementCount,
      algorithm3D: meshed.algorithm3D,
      attributedSets: meshed.attribution?.attributedSetCount ?? 0,
      totalSets: meshed.attribution?.sets.length ?? 0,
      supportFaceId: scenario.faces.supportFace.faceId,
      loadFaceId: scenario.faces.loadFace.faceId,
      mappingModes: mappingDiagnostics.map((diagnostic) => ({
        role: diagnostic.role,
        mode: diagnostic.mode,
        surfaceSet: diagnostic.surfaceSet,
        matchedFacetCount: diagnostic.matchedFacetCount
      })),
      usedGeometricFallback: mappingDiagnostics.some((diagnostic) => diagnostic.mode === "geometric"),
      phases,
      totalMs: Math.round(meshed.totalMs),
      solve: outcome.ok && summary
        ? {
            ok: true,
            solverBackend: outcome.solverBackend,
            maxStress: summary!.maxStress,
            maxStressUnits: summary!.maxStressUnits,
            maxDisplacement: summary!.maxDisplacement,
            maxDisplacementUnits: summary!.maxDisplacementUnits,
            reactionForce: summary!.reactionForce,
            appliedForce: STEP_PROOF_LOAD_NEWTONS,
            reactionMatchesApplied: Math.abs(summary!.reactionForce - STEP_PROOF_LOAD_NEWTONS) / STEP_PROOF_LOAD_NEWTONS < 0.02
          }
        : { ok: false, appliedForce: STEP_PROOF_LOAD_NEWTONS, reason: outcome.ok ? "Unexpected modal result in structural mesh proof." : outcome.reason }
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error) };
  }
}

// A-M4: full mesh-then-solve run proof through the PRODUCTION run flow
// (lib/api.runSimulation). Starts from a bracket study with NO stored mesh
// artifact (preset-estimate summary), so the local run must wasm-mesh first
// (real phase progress events in the run stream), then solve, then produce
// results labeled as a local browser solve.
export type RunProofResult = {
  ok: boolean;
  error?: string;
  runId?: string;
  streamUrl?: string;
  runSolverBackend?: string;
  events?: Array<{ type: string; progress?: number; message: string }>;
  sawMeshingEvents?: boolean;
  sawSolveEvents?: boolean;
  completed?: boolean;
  meshedStudyStoredArtifact?: boolean;
  results?: {
    maxStress?: number;
    maxStressUnits?: string;
    reactionForce?: number;
    provenanceSolver?: string;
    provenanceRunnerVersion?: string;
    provenanceResultSource?: string;
    labeledLocal?: boolean;
  };
};

async function runMeshThenSolveRunProof(): Promise<RunProofResult> {
  try {
    const [{ createLocalSampleProject }, api] = await Promise.all([
      import("../localProjectFactory"),
      import("../lib/api")
    ]);
    const sample = await createLocalSampleProject("bracket", "static_stress");
    const baseStudy = sample.project.studies[0];
    if (!baseStudy) return { ok: false, error: "bracket sample produced no study" };
    // NO stored artifact: a completed mesh step whose summary is only a
    // preset estimate — the run flow must mesh for real before solving.
    const study = {
      ...baseStudy,
      meshSettings: {
        preset: "medium" as const,
        status: "complete" as const,
        meshRef: `${baseStudy.projectId}/mesh/mesh-summary.json`,
        summary: { nodes: 42381, elements: 26944, warnings: [], quality: "medium" as const, source: "preset_estimate" as const }
      }
    };

    let meshedStudyStoredArtifact = false;
    const response = await api.runSimulation(study.id, study, sample.displayModel, {
      onStudyMeshed: (meshedStudy) => {
        const artifacts = (meshedStudy.meshSettings.summary as { artifacts?: { actualCoreModel?: unknown } } | undefined)?.artifacts;
        meshedStudyStoredArtifact = Boolean(artifacts?.actualCoreModel);
      }
    });

    const events: Array<{ type: string; progress?: number; message: string }> = [];
    const terminal = await new Promise<{ type: string; message: string }>((resolve) => {
      const source = api.subscribeToRun(response.run.id, (event) => {
        events.push({ type: event.type, progress: event.progress, message: event.message });
        if (event.type === "complete" || event.type === "error" || event.type === "cancelled") {
          source.close();
          resolve({ type: event.type, message: event.message });
        }
      });
    });

    const completed = terminal.type === "complete";
    const results = completed ? await api.getResults(response.run.id) : undefined;
    const structuralSummary = results && !isModalResultSummary(results.summary) ? results.summary : undefined;
    const provenance = results?.summary.provenance as
      | { solver?: string; runnerVersion?: string; resultSource?: string }
      | undefined;
    return {
      ok: completed,
      ...(completed ? {} : { error: `terminal=${terminal.type}: ${terminal.message}` }),
      runId: response.run.id,
      streamUrl: response.streamUrl,
      runSolverBackend: (response.run as { solverBackend?: string }).solverBackend,
      events,
      sawMeshingEvents: events.some((event) => /meshing/i.test(event.message)),
      sawSolveEvents: events.some((event) => /assembling|solving/i.test(event.message)),
      completed,
      meshedStudyStoredArtifact,
      ...(structuralSummary
        ? {
            results: {
              maxStress: structuralSummary.maxStress,
              maxStressUnits: structuralSummary.maxStressUnits,
              reactionForce: structuralSummary.reactionForce,
              provenanceSolver: provenance?.solver,
              provenanceRunnerVersion: provenance?.runnerVersion,
              provenanceResultSource: provenance?.resultSource,
              // Local solves are marked by the browser runner stamp (the
              // solver id keeps runner parity naming).
              labeledLocal: Boolean(provenance?.runnerVersion?.startsWith("browser-"))
            }
          }
        : {})
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error) };
  }
}

declare global {
  interface Window {
    __opencaeMeshProof?: {
      runBracket: typeof runBracketProof;
      runStep: typeof runStepProof;
      runMeshThenSolve: typeof runMeshThenSolveRunProof;
      /** Set once an auto-run (triggered by ?meshProof=1|step|run) finishes. */
      lastResult?: MeshProofResult;
      lastStepResult?: StepProofResult;
      lastRunResult?: RunProofResult;
    };
  }
}

window.__opencaeMeshProof = { runBracket: runBracketProof, runStep: runStepProof, runMeshThenSolve: runMeshThenSolveRunProof };

// ?meshProof=1 auto-runs the bracket proof, ?meshProof=step the STEP proof;
// both mirror the outcome into document.title + console so dump-dom style
// headless capture works too.
const meshProofMode = new URLSearchParams(window.location.search).get("meshProof");
if (meshProofMode === "1") {
  void runBracketProof().then((result) => {
    window.__opencaeMeshProof!.lastResult = result;
    const title = result.ok
      ? `MESHPROOF OK nodes=${result.nodeCount} elements=${result.elementCount} type=${result.elementType} totalMs=${result.totalMs}`
      : `MESHPROOF FAIL ${result.error.split("\n")[0]}`;
    document.title = title;
    console.log(`[meshProof] ${title}`, result);
  });
} else if (meshProofMode === "step") {
  void runStepProof().then((result) => {
    window.__opencaeMeshProof!.lastStepResult = result;
    const title = result.ok
      ? `STEPPROOF ${result.usedGeometricFallback || !result.solve.ok ? "FAIL" : "OK"} nodes=${result.nodeCount} elements=${result.elementCount} ` +
        `mapping=${result.mappingModes.map((entry) => `${entry.role}:${entry.mode}`).join(",")} reaction=${result.solve.reactionForce ?? "n/a"}`
      : `STEPPROOF FAIL ${result.error.split("\n")[0]}`;
    document.title = title;
    console.log(`[meshProof:step] ${title}`, result);
  });
} else if (meshProofMode === "run") {
  void runMeshThenSolveRunProof().then((result) => {
    window.__opencaeMeshProof!.lastRunResult = result;
    const title = result.ok
      ? `RUNPROOF OK meshFirst=${result.sawMeshingEvents} solve=${result.sawSolveEvents} local=${result.results?.labeledLocal} ` +
        `maxStress=${result.results?.maxStress?.toFixed(2)}${result.results?.maxStressUnits ?? ""}`
      : `RUNPROOF FAIL ${(result.error ?? "unknown").split("\n")[0]}`;
    document.title = title;
    console.log(`[meshProof:run] ${title}`, result);
  });
}
