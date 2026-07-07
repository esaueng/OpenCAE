// Browser benchmark harness for the 100k-DOF browser solve cap (plan 015:
// "keep the staged cap at 60k until ... a WebKit target-scale run lands").
// Flag-gated like the mesh proof harnesses: main.tsx lazy-imports this chunk
// only when the URL carries ?solveBench, so normal sessions never load it and
// the initial bundle stays untouched.
//
// What it does, all through REAL production pieces:
//   1. Meshes the box-with-bore STEP fixture with gmsh-wasm in the mesh worker
//      at a characteristic size calibrated to land just under 100k DOFs
//      (2.22 mm -> 33,115 Tet10 nodes = 99,345 DOFs, measured in Node/V8 and
//      deterministic across engines: identical wasm binary + input). An
//      adaptive retry re-scales the size by cbrt(nodes/target) if an engine
//      ever lands outside the 90k..100k band.
//   2. Builds the Core model exactly like the A-M3 STEP path (face registry ->
//      attribution -> buildCoreModelFromCloudMesh) and stores it as the
//      study's wasm mesh artifact.
//   3. Solves through the dedicated solve worker (solveWorkerClient) under the
//      production BROWSER_SOLVE_LIMITS, capturing per-phase wall times and CG
//      iterations from the real solver progress events, plus peak JS heap
//      where the engine exposes it (performance.memory is Chrome-only; the
//      solve worker samples its own heap inside the progress hook; WebKit
//      reports wall time + success only).
//   4. Sanity-checks the result: finite positive maxStress/maxDisplacement and
//      reaction ~= the applied 500 N load.
//
// scripts/verify-100k-solve.mjs drives this in headless Chrome AND Playwright
// WebKit and hard-gates on both engines succeeding with matching results.
import { buildCoreModelFromCloudMesh, type SelectionMappingDiagnostic } from "@opencae/mesh-intake";
import { BROWSER_SOLVE_LIMITS, type SolveProgressEvent } from "@opencae/solve-pipeline";
import { unpackCoreVolumeMeshArtifact, type MeshWorkerPhase } from "./meshProtocol";
import { meshStepFileInWorker } from "./meshWorkerClient";
import { startLocalSolve } from "./solveWorkerClient";
import { stepAttributionForRegistry, stepFaceRegistryFromBase64 } from "../stepFaces";
import { STEP_PROOF_LOAD_NEWTONS, stepProofScenario, studyWithWasmMeshSummary } from "./stepProofScenario";
import boxWithBoreStep from "../../../../libs/opencae-mesh-intake/fixtures/box-with-bore.step?raw";

/** Calibrated for box-with-bore.step: 33,115 Tet10 nodes = 99,345 DOFs (Node/V8 gmsh-wasm). */
export const DEFAULT_BENCH_MESH_SIZE_MM = 2.22;
const TARGET_NODE_COUNT = 32000;
const MIN_BENCH_DOFS = 90000;
const MAX_MESH_ATTEMPTS = 3;
const MAIN_HEAP_SAMPLE_INTERVAL_MS = 250;

type PhaseTiming = {
  /** First progress event of the phase relative to solve dispatch (ms). */
  startedAtMs: number;
  /** Last progress event of the phase relative to solve dispatch (ms). */
  lastEventAtMs: number;
  events: number;
};

export type SolveBenchResult = {
  ok: true;
  userAgent: string;
  appliedLimitMaxDofs: number;
  meshSizeMm: number;
  meshAttempts: Array<{ meshSizeMm: number; nodeCount: number; dofs: number }>;
  nodeCount: number;
  elementCount: number;
  dofs: number;
  meshMs: number;
  meshPhases: Array<{ phase: MeshWorkerPhase; elapsedMs: number }>;
  solverBackend: string;
  solve: {
    totalMs: number;
    /** Solve dispatch -> first assemble progress event (worker spawn + payload transfer + validation). */
    setupMs: number;
    /** First assemble event -> first solve (CG) event. */
    assembleMs: number;
    /** First CG event -> last CG event. Progress forwarding is throttled at 50 ms, so +-1 forward interval. */
    cgMs: number;
    /** Last CG event -> result received (stress recovery + postprocess + validation + transfer). */
    recoverMs: number;
    /** Highest CG iteration observed in progress events (solver reports every 25 iterations + on convergence). */
    cgIterations: number;
    lastRelativeResidual?: number;
    phases: Record<string, PhaseTiming>;
  };
  memory: {
    /** Peak usedJSHeapSize sampled INSIDE the solve worker's progress hook (Chrome-only). */
    workerPeakHeapBytes?: number;
    /** Peak main-thread usedJSHeapSize polled during mesh+solve (Chrome-only; workers have separate heaps). */
    mainThreadPeakHeapBytes?: number;
    /** performance.measureUserAgentSpecificMemory() after the solve, when exposed (needs cross-origin isolation). */
    uaSpecificMemoryBytes?: number;
    /**
     * Injected by scripts/verify-100k-solve.mjs (not measurable from page JS):
     * peak RSS of the largest Chrome child process polled during the bench —
     * the renderer hosting the solve worker heap + gmsh wasm memory.
     */
    rendererPeakRssBytes?: number;
    /** Injected by the driver: kernel phys_footprint_peak of that renderer at bench end (macOS). */
    rendererFootprintPeakBytes?: number;
    /** Injected by the driver: phys_footprint_peak snapshot taken when the solve phase began. */
    rendererPreSolveFootprintPeakBytes?: number;
    performanceMemorySupported: boolean;
  };
  summary: {
    maxStress: number;
    maxStressUnits?: string;
    maxDisplacement: number;
    maxDisplacementUnits?: string;
    reactionForce: number;
    appliedForce: number;
    reactionRelativeError: number;
  };
  sanity: {
    finiteMaxStress: boolean;
    finiteMaxDisplacement: boolean;
    reactionMatchesApplied: boolean;
  };
} | { ok: false; error: string };

function sampleHeapBytes(): number | undefined {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
  return typeof memory?.usedJSHeapSize === "number" && Number.isFinite(memory.usedJSHeapSize)
    ? memory.usedJSHeapSize
    : undefined;
}

async function measureUaSpecificMemoryBytes(): Promise<number | undefined> {
  const measure = (performance as unknown as { measureUserAgentSpecificMemory?: () => Promise<{ bytes?: number }> })
    .measureUserAgentSpecificMemory;
  if (typeof measure !== "function") return undefined;
  try {
    const measured = await measure.call(performance);
    return typeof measured?.bytes === "number" ? measured.bytes : undefined;
  } catch {
    return undefined;
  }
}

export async function runSolveBench(options: { meshSizeMm?: number; minDofs?: number } = {}): Promise<SolveBenchResult> {
  // minDofs is a debug knob for off-scale memory comparisons (e.g. a 60k-DOF
  // counterfactual); the driver script's gates always require the real
  // 90k..100k band regardless of what the harness accepted.
  const minBenchDofs = options.minDofs ?? MIN_BENCH_DOFS;
  let mainThreadPeakHeapBytes = sampleHeapBytes();
  const heapPoller = setInterval(() => {
    const bytes = sampleHeapBytes();
    if (bytes !== undefined && (mainThreadPeakHeapBytes === undefined || bytes > mainThreadPeakHeapBytes)) {
      mainThreadPeakHeapBytes = bytes;
    }
  }, MAIN_HEAP_SAMPLE_INTERVAL_MS);

  try {
    markPhase("registry");
    const contentBase64 = btoa(boxWithBoreStep);
    const registry = await stepFaceRegistryFromBase64(contentBase64);
    const scenario = stepProofScenario(registry, { filename: "box-with-bore.step", contentBase64 });

    const stepBytes = new TextEncoder().encode(boxWithBoreStep);

    // Mesh at the calibrated size; adaptively re-scale if the node count lands
    // outside the 90k..100k DOF band (never observed with the pinned gmsh-wasm,
    // but the gate must fail loudly rather than silently benching off-scale).
    let meshSizeMm = options.meshSizeMm ?? DEFAULT_BENCH_MESH_SIZE_MM;
    const meshAttempts: Array<{ meshSizeMm: number; nodeCount: number; dofs: number }> = [];
    markPhase("meshing");
    let meshed: Awaited<ReturnType<typeof meshStepFileInWorker>> | undefined;
    let meshPhases: Array<{ phase: MeshWorkerPhase; elapsedMs: number }> = [];
    let artifact: ReturnType<typeof unpackCoreVolumeMeshArtifact> | undefined;
    for (let attempt = 0; attempt < MAX_MESH_ATTEMPTS; attempt += 1) {
      const phases: Array<{ phase: MeshWorkerPhase; elapsedMs: number }> = [];
      const stepContent = new ArrayBuffer(stepBytes.byteLength);
      new Uint8Array(stepContent).set(stepBytes);
      // Rebuilt per attempt: the mesh worker request transfers the attribution
      // buffers, detaching them from this thread.
      const attribution = stepAttributionForRegistry(registry);
      const attemptMeshed = await meshStepFileInWorker(
        { stepContent, elementOrder: 2, units: "mm", meshSizeMm, attribution },
        (progress) => phases.push({ phase: progress.phase, elapsedMs: Math.round(progress.elapsedMs) })
      );
      const attemptArtifact = unpackCoreVolumeMeshArtifact(attemptMeshed.packed);
      const nodeCount = attemptArtifact.metadata.nodeCount;
      const dofs = nodeCount * 3;
      meshAttempts.push({ meshSizeMm, nodeCount, dofs });
      if (dofs >= minBenchDofs && dofs <= BROWSER_SOLVE_LIMITS.maxDofs) {
        meshed = attemptMeshed;
        meshPhases = phases;
        artifact = attemptArtifact;
        break;
      }
      meshSizeMm = Number((meshSizeMm * Math.cbrt(nodeCount / TARGET_NODE_COUNT)).toFixed(3));
    }
    if (!meshed || !artifact) {
      return {
        ok: false,
        error: `Mesh never landed in the ${minBenchDofs}..${BROWSER_SOLVE_LIMITS.maxDofs} DOF band: ` +
          meshAttempts.map((entry) => `${entry.meshSizeMm}mm -> ${entry.dofs} DOFs`).join(", ")
      };
    }

    markPhase("building-model");
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
    const dofs = model.nodes.coordinates.length;
    const solvableStudy = studyWithWasmMeshSummary({ study: scenario.study, artifact, model, mappingDiagnostics });

    // Solve through the REAL dedicated solve worker under production limits.
    const phases: Record<string, PhaseTiming> = {};
    let cgIterations = 0;
    let lastRelativeResidual: number | undefined;
    const solveStartedAt = performance.now();
    const onProgress = (event: SolveProgressEvent) => {
      const atMs = performance.now() - solveStartedAt;
      const timing = phases[event.phase] ?? (phases[event.phase] = { startedAtMs: atMs, lastEventAtMs: atMs, events: 0 });
      timing.lastEventAtMs = atMs;
      timing.events += 1;
      if (event.phase === "solve") {
        if (typeof event.iteration === "number" && event.iteration > cgIterations) cgIterations = event.iteration;
        if (typeof event.relativeResidual === "number") lastRelativeResidual = event.relativeResidual;
      }
    };
    markPhase("solving");
    const handle = startLocalSolve(
      { runId: "run-solve-bench-100k", study: solvableStudy, displayModel: scenario.displayModel },
      onProgress
    );
    const completion = await handle.completion;
    const totalMs = performance.now() - solveStartedAt;
    markPhase("done");

    const assemble = phases.assemble;
    const cg = phases.solve;
    const setupMs = assemble?.startedAtMs ?? 0;
    const assembleMs = assemble && cg ? cg.startedAtMs - assemble.startedAtMs : 0;
    const cgMs = cg ? cg.lastEventAtMs - cg.startedAtMs : 0;
    const recoverMs = cg ? totalMs - cg.lastEventAtMs : 0;

    const summary = completion.result.summary as {
      maxStress: number;
      maxStressUnits?: string;
      maxDisplacement: number;
      maxDisplacementUnits?: string;
      reactionForce: number;
    };
    const reactionRelativeError = Math.abs(summary.reactionForce - STEP_PROOF_LOAD_NEWTONS) / STEP_PROOF_LOAD_NEWTONS;
    const uaSpecificMemoryBytes = await measureUaSpecificMemoryBytes();

    return {
      ok: true,
      userAgent: navigator.userAgent,
      appliedLimitMaxDofs: BROWSER_SOLVE_LIMITS.maxDofs,
      meshSizeMm,
      meshAttempts,
      nodeCount: artifact.metadata.nodeCount,
      elementCount: artifact.metadata.elementCount,
      dofs,
      meshMs: Math.round(meshed.totalMs),
      meshPhases,
      solverBackend: completion.solverBackend,
      solve: {
        totalMs: Math.round(totalMs),
        setupMs: Math.round(setupMs),
        assembleMs: Math.round(assembleMs),
        cgMs: Math.round(cgMs),
        recoverMs: Math.round(recoverMs),
        cgIterations,
        ...(lastRelativeResidual !== undefined ? { lastRelativeResidual } : {}),
        phases
      },
      memory: {
        ...(completion.workerPeakHeapBytes !== undefined ? { workerPeakHeapBytes: completion.workerPeakHeapBytes } : {}),
        ...(mainThreadPeakHeapBytes !== undefined ? { mainThreadPeakHeapBytes } : {}),
        ...(uaSpecificMemoryBytes !== undefined ? { uaSpecificMemoryBytes } : {}),
        performanceMemorySupported: sampleHeapBytes() !== undefined
      },
      summary: {
        maxStress: summary.maxStress,
        maxStressUnits: summary.maxStressUnits,
        maxDisplacement: summary.maxDisplacement,
        maxDisplacementUnits: summary.maxDisplacementUnits,
        reactionForce: summary.reactionForce,
        appliedForce: STEP_PROOF_LOAD_NEWTONS,
        reactionRelativeError
      },
      sanity: {
        finiteMaxStress: Number.isFinite(summary.maxStress) && summary.maxStress > 0,
        finiteMaxDisplacement: Number.isFinite(summary.maxDisplacement) && summary.maxDisplacement > 0,
        reactionMatchesApplied: reactionRelativeError < 0.01
      }
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error) };
  } finally {
    clearInterval(heapPoller);
  }
}

export type SolveBenchPhase = "loading" | "registry" | "meshing" | "building-model" | "solving" | "done";

declare global {
  interface Window {
    __opencaeSolveBench?: {
      run: typeof runSolveBench;
      /**
       * Coarse phase marker so the driver script can attribute process-level
       * memory peaks (e.g. gmsh wasm arena vs solver assembly transient).
       */
      phase?: SolveBenchPhase;
      /** Set once the auto-run (triggered by ?solveBench=1) finishes. */
      lastResult?: SolveBenchResult;
    };
  }
}

window.__opencaeSolveBench = { run: runSolveBench, phase: "loading" };

function markPhase(phase: SolveBenchPhase): void {
  if (window.__opencaeSolveBench) window.__opencaeSolveBench.phase = phase;
}

const params = new URLSearchParams(window.location.search);
if (params.get("solveBench") === "1") {
  const meshSizeParam = Number(params.get("meshSizeMm"));
  const minDofsParam = Number(params.get("minDofs"));
  void runSolveBench({
    ...(Number.isFinite(meshSizeParam) && meshSizeParam > 0 ? { meshSizeMm: meshSizeParam } : {}),
    ...(Number.isFinite(minDofsParam) && minDofsParam > 0 ? { minDofs: minDofsParam } : {})
  }).then((result) => {
    window.__opencaeSolveBench!.lastResult = result;
    const title = result.ok
      ? `SOLVEBENCH OK dofs=${result.dofs} meshMs=${result.meshMs} solveMs=${result.solve.totalMs} ` +
        `cgIters=${result.solve.cgIterations} workerPeakHeapMB=${result.memory.workerPeakHeapBytes !== undefined ? Math.round(result.memory.workerPeakHeapBytes / 1e6) : "n/a"} ` +
        `reaction=${result.summary.reactionForce.toFixed(2)}N`
      : `SOLVEBENCH FAIL ${result.error.split("\n")[0]}`;
    document.title = title;
    console.log(`[solveBench] ${title}`, result);
  });
}
