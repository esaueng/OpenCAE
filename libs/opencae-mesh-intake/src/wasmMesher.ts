// Drives @loumalouomega/gmsh-wasm (gmsh compiled to WebAssembly) to produce
// msh v2.2 volume meshes entirely in-process (MEMFS only — no child processes,
// no real filesystem), so the same code runs in Node tests and browser workers.
//
// The WASM module is lazy-loaded via dynamic import so browser bundles only pay
// for it when meshing actually starts (the .wasm asset is ~44 MB).

import { MESH_QUALITY_REJECT_MIN_SICN } from "./meshQualityGate";
import type { ElementOrderFallbackMetadata } from "./types";

type GmshWasmModule = typeof import("@loumalouomega/gmsh-wasm");
export type GmshApi = Awaited<ReturnType<GmshWasmModule["default"]>>;

export type MeshPhase = "load" | "init" | "import" | "mesh2d" | "mesh3d" | "order2" | "write";
/**
 * Which robustness-ladder attempt a phase event belongs to. The size/algorithm
 * ladder and the quality repair legitimately re-run whole gmsh sessions, so
 * without this context the repeated phase stream is indistinguishable from an
 * infinite loop for callers showing progress.
 */
export type MeshAttemptContext = { attempt: number; stage: "size" | "repair"; sizeMm?: number };
export type MeshPhaseEvent = { phase: MeshPhase; elapsedMs: number; attempt?: MeshAttemptContext };
export type MeshTimings = Partial<Record<MeshPhase, number>>;

export type MeshWasmOptions = {
  elementOrder?: 1 | 2;
  onPhase?: (event: MeshPhaseEvent) => void;
};

export type StepMeshWasmOptions = MeshWasmOptions & {
  /** Characteristic mesh size in the STEP file's model units (our fixtures are mm). */
  meshSizeMm?: number;
  /** Exact preview-body bounds to retain as structural solids; other disconnected STEP volumes are payload/visual-only. */
  structuralBodyBounds?: StepBodyBounds[];
  /** Preserve imported STEP volumes as separate mesh components for assembly connections. Defaults to false for legacy single-part studies. */
  preservePartIdentity?: boolean;
};

export type StepBodyBounds = {
  min: [number, number, number];
  max: [number, number, number];
};

export type GeoMeshResult = {
  msh: string;
  timings: MeshTimings;
  totalMs: number;
  /** Min signed inverse condition number over all volume elements (gmsh minSICN). */
  qualityMinSICN?: number;
};

export type StepMeshResult = GeoMeshResult & {
  /** Which 3D algorithm produced the mesh: gmsh default Delaunay, or the Frontal fallback. */
  algorithm3D: "delaunay" | "frontal";
  /**
   * How Tet10 mid-side nodes were placed (order-2 meshes only). "curved"
   * snaps them onto the CAD surface (gmsh default); "straight_edge" is the
   * rescue applied when curved elevation inverts elements on thin or bent
   * geometry (Mesh.SecondOrderLinear re-elevation).
   */
  elevation?: "curved" | "straight_edge";
  /**
   * Present when the linear mesh missed the quality floor and gmsh's Netgen
   * optimizer repaired it in-session (local sliver splitting/smoothing).
   */
  optimizer?: "netgen";
  /**
   * Present when the requested size missed the quality-gate floor and the
   * mesh was automatically retried at nearby characteristic lengths.
   */
  qualityRefinement?: {
    requestedMeshSizeMm: number;
    usedMeshSizeMm: number;
    triedMeshSizesMm: number[];
    direction: "finer" | "coarser";
  };
  /**
   * Present when a bounded CAD-healing + MeshAdapt pass recovered a mesh that
   * the ordinary size/algorithm ladder could not bring above the quality floor.
   */
  qualityRepair?: {
    method: "occ_heal_meshadapt";
    requestedMeshSizeMm: number;
    usedMeshSizeMm: number;
    triedMeshSizesMm: number[];
  };
  /** Present when the imported STEP boundary had to be healed before volume meshing. */
  geometryRepair?: StepGeometryRepairReport;
  /** Present when a safe Tet10 mesh was reduced to Tet4 to stay solvable in-browser. */
  elementOrderFallback?: ElementOrderFallbackMetadata;
  /** Present when multiple imported solids were fused into fewer volumes before meshing. */
  multiBodyFusion?: StepMultiBodyFusionReport;
};

export type StepMultiBodyFusionReport = {
  inputVolumeCount: number;
  fusedVolumeCount: number;
};

export type StepGeometryInspection = {
  status: "solid" | "open_shell" | "invalid";
  volumeCount: number;
  surfaceCount: number;
  orphanSurfaceCount: number;
  openBoundaryCurveCount: number;
  surfaceMeshValid: boolean;
  repairable: boolean;
  issue?: "no_solid_volume" | "open_boundaries" | "orphan_surfaces" | "degenerate_volume" | "invalid_surface_loop" | "import_failed";
  message?: string;
};

export type StepGeometryRepairReport = {
  method: "heal" | "heal_and_cap";
  profile: "automatic" | "quality" | "explicit";
  toleranceMm: number;
  cappedSurfaceCount: number;
  originalVolumeCount: number;
  repairedVolumeCount: number;
  originalOpenBoundaryCurveCount: number;
  repairedOpenBoundaryCurveCount: number;
  originalOrphanSurfaceCount: number;
  repairedOrphanSurfaceCount: number;
  originalVolumeMm3?: number;
  repairedVolumeMm3?: number;
  relativeVolumeChange?: number;
  relativeBoundsChange: number;
};

export type StepGeometryRepairResult = {
  stepContent: Uint8Array;
  inspection: StepGeometryInspection;
  repair: StepGeometryRepairReport;
};

export class StepGeometryError extends Error {
  override name = "StepGeometryError";
}

/** Stable marker for the repair path that starts with a volume but loses it while sewing. */
export const STEP_GEOMETRY_REPAIR_LOST_VOLUME_ERROR_NAME = "StepGeometryRepairLostVolume";

const FIX_OPEN_SURFACES_ACTION =
  "Use Fix open surfaces on the Model step, or re-export the part from CAD as a solid body.";

/**
 * Extra Emscripten Module options passed to the gmsh-wasm factory on every
 * instantiation (fresh module per mesh). The browser mesh worker uses this to
 * supply `wasmBinary` fetched from the gzip-precompressed deploy asset
 * (Cloudflare caps static assets at 25 MiB per file, so the raw ~44 MB
 * gmsh-core.wasm never ships uncompressed). Node keeps the default loader,
 * which reads the .wasm straight from node_modules.
 */
let gmshWasmModuleOptionsProvider: (() => Promise<Record<string, unknown>>) | null = null;

export function configureGmshWasmModuleOptions(provider: (() => Promise<Record<string, unknown>>) | null): void {
  gmshWasmModuleOptionsProvider = provider;
}

/**
 * Instantiate a FRESH gmsh WASM module. Deliberately not cached: gmsh-wasm
 * 0.1.2 aborts inside wasm on the second gmsh session per module instance
 * (initialize -> finalize -> initialize crashes, and so does clear()-based
 * model reuse — verified against the STEP/OCC path in Node 22). One module
 * instance per mesh is the reliable pattern; instantiation costs ~0.1-0.5 s
 * on top of the (engine-cached) dynamic import.
 */
export async function loadGmshWasm(): Promise<GmshApi> {
  const mod = await import("@loumalouomega/gmsh-wasm");
  const moduleOptions = gmshWasmModuleOptionsProvider ? await gmshWasmModuleOptionsProvider() : {};
  return mod.default(moduleOptions);
}

/**
 * Mesh a gmsh .geo script (OpenCASCADE factory supported) to a msh v2.2 string.
 * Runs a full gmsh session (initialize/finalize) per call so repeated meshes
 * never leak model state into each other.
 */
export async function meshGeoScriptToMshV2(geoScript: string, options: MeshWasmOptions = {}): Promise<GeoMeshResult> {
  const totalStart = now();
  const timings: MeshTimings = {};
  const gmsh = await timePhase(timings, options, "load", totalStart, async () => loadGmshWasm());
  timePhaseSync(timings, options, "init", totalStart, () => {
    gmsh.initialize();
    quietLogger(gmsh);
  });
  try {
    timePhaseSync(timings, options, "import", totalStart, () => {
      gmsh.FS.writeFile("/model.geo", geoScript);
      gmsh.open("/model.geo");
    });
    timePhaseSync(timings, options, "mesh2d", totalStart, () => gmsh.model.mesh.generate(2));
    timePhaseSync(timings, options, "mesh3d", totalStart, () => gmsh.model.mesh.generate(3));
    if (options.elementOrder === 2) {
      timePhaseSync(timings, options, "order2", totalStart, () => gmsh.model.mesh.setOrder(2));
    }
    const qualityMinSICN = minSICNQuality(gmsh);
    const msh = timePhaseSync(timings, options, "write", totalStart, () => writeMshV2(gmsh));
    return { msh, timings, totalMs: now() - totalStart, ...(qualityMinSICN !== undefined ? { qualityMinSICN } : {}) };
  } finally {
    safeFinalize(gmsh);
  }
}

/**
 * Nearby characteristic-length attempts when the requested size misses the
 * quality floor. Tet quality is non-monotonic in size, so try the adjacent
 * coarser size as well as the two existing finer sizes.
 */
// Keep one deep-refinement rung for valid, feature-dense solids whose coarse
// surface triangulation intersects itself during PLC recovery. The CAE load
// test bracket (160 x 60 x 10 mm, 210 faces) fails from 12 mm through 3 mm but
// produces a passing 18k-tet mesh at 2 mm. This rung is still guarded by the
// existing tet/DOF limits, so genuinely large refinements cannot enter the
// browser solver unchecked.
const QUALITY_SIZE_MULTIPLIERS = [1, 3 / 2, 2 / 3, 4 / 9, 1 / 6] as const;
/** Stop refining once a mesh gets this large — the solver caps DOF anyway. */
const MAX_QUALITY_REFINEMENT_TETS = 80_000;
/** The browser solve pipeline accepts at most 100,000 displacement DOFs. */
const MAX_BROWSER_SOLVE_NODES = Math.floor(100_000 / 3);
/**
 * Large imported solids with residual free-edge seams can exhaust a browser
 * worker when every size and 3D-algorithm candidate is tried before OCC
 * healing. At this complexity the seam topology, rather than characteristic
 * length, is the useful recovery signal.
 */
const COMPLEX_SEAM_REPAIR_SURFACE_THRESHOLD = 128;
/**
 * A conservative upper size for the healed MeshAdapt rescue. The supplied
 * sliver-heavy STEP and neighboring sizes show a stable passing window at
 * 5-6 mm; larger sizes can reintroduce the same sliver non-monotonically.
 */
const MAX_QUALITY_REPAIR_SIZE_MM = 6;

/**
 * Import a STEP file through the OpenCASCADE kernel and volume-mesh it to msh v2.2.
 *
 * Two layers of robustness, both measured on real thin-walled parts:
 * - The single-threaded WASM build of gmsh has a documented weakness in the
 *   default Delaunay 3D algorithm's boundary recovery; when generate(3) fails
 *   the session retries with Mesh.Algorithm3D = 4 (Frontal).
 * - A completed Delaunay mesh can still miss the quality floor, especially
 *   when Netgen crashed and the safe no-optimizer retry completed. That is a
 *   quality failure, not a successful fallback: retry Frontal and keep the
 *   better result.
 * - Thin walls produce sliver tets whose quality is NON-monotonic in mesh
 *   size (a 2 mm-wall clip scores minSICN 0.02 at 12 mm, 0.009 at 6 mm, but
 *   0.25 at 8 mm), so a failed requested size is retried once coarser and up
 *   to two steps finer. The first passing size wins and the adjustment is
 *   recorded so callers can surface it honestly.
 */
export async function meshStepToMshV2(stepContent: Uint8Array | string, options: StepMeshWasmOptions = {}): Promise<StepMeshResult> {
  const totalStart = now();
  const requestedSizeMm = options.meshSizeMm;
  type Candidate = StepMeshCandidate & { sizeMm?: number };
  let best: Candidate | undefined;
  const triedSizesMm: number[] = [];
  let skipFinerSizes = false;
  let preferQualityRepair = false;
  let lastError: unknown;
  // Stamp every phase event with its ladder attempt so progress consumers can
  // show "retrying at 8 mm (attempt 3)" instead of a silent repeating loop.
  let attemptNumber = 0;
  const optionsForAttempt = (stage: MeshAttemptContext["stage"], sizeMm?: number): StepMeshWasmOptions => {
    attemptNumber += 1;
    const attempt: MeshAttemptContext = { attempt: attemptNumber, stage, ...(sizeMm !== undefined ? { sizeMm } : {}) };
    return {
      ...options,
      onPhase: options.onPhase ? (event) => options.onPhase!({ ...event, attempt }) : undefined
    };
  };

  const consider = (result: StepMeshCandidate, sizeMm?: number): boolean => {
    if (best === undefined || qualityOf(result) > qualityOf(best)) best = { ...result, sizeMm };
    if (result.preferQualityRepair) preferQualityRepair = true;
    return meshResultPassesQuality(result);
  };

  const tryStandardSize = async (sizeMm?: number): Promise<boolean> => {
    if (sizeMm !== undefined) triedSizesMm.push(sizeMm);
    try {
      const result = await meshStepWithAlgorithmFallback(stepContent, { ...optionsForAttempt("size", sizeMm), meshSizeMm: sizeMm }, totalStart);
      if (countTetLines(result.msh) > MAX_QUALITY_REFINEMENT_TETS) skipFinerSizes = true;
      return consider(result, sizeMm);
    } catch (error) {
      lastError = error;
      if (isQualityRepairRecommended(error)) preferQualityRepair = true;
      return false;
    }
  };

  // Exhaust the ordinary size/algorithm ladder before the broader sliver-heal
  // profile. Tet quality is non-monotonic, so requested, coarser, and finer
  // candidates can each be the one that clears the floor without that repair.
  for (const multiplier of QUALITY_SIZE_MULTIPLIERS) {
    if (multiplier < 1 && skipFinerSizes) continue;
    const sizeMm = requestedSizeMm !== undefined && requestedSizeMm > 0
      ? requestedSizeMm * multiplier
      : undefined;
    if (await tryStandardSize(sizeMm)) break;
    if (preferQualityRepair) break;
    if (sizeMm === undefined) break;
  }

  // Only after the complete ordinary ladder still produces a sub-floor mesh
  // (or no volume mesh), run a bounded, fresh-session quality repair. This
  // removes tiny OCC edges/faces under strict bounds/volume-change guards and
  // uses MeshAdapt's surface triangulation before Delaunay + Netgen. It does
  // not lower the gate.
  if (!best || !meshResultPassesQuality(best)) {
    const standardLadderError = lastError;
    const repairSizesMm = qualityRepairSizes(requestedSizeMm);
    const repairTriedSizesMm: number[] = [];
    let repairLostImportedVolume = false;
    for (const sizeMm of repairSizesMm) {
      repairTriedSizesMm.push(sizeMm);
      if (!triedSizesMm.includes(sizeMm)) triedSizesMm.push(sizeMm);
      try {
        const result = meshStepSession(
          await loadGmshWasm(),
          stepContent,
          { ...optionsForAttempt("repair", sizeMm), meshSizeMm: sizeMm },
          "delaunay",
          now(),
          true,
          "quality"
        );
        const repairedResult: StepMeshCandidate = {
          ...result,
          qualityRepair: {
            method: "occ_heal_meshadapt",
            requestedMeshSizeMm: requestedSizeMm!,
            usedMeshSizeMm: sizeMm,
            triedMeshSizesMm: [...repairTriedSizesMm]
          }
        };
        if (consider(repairedResult, sizeMm)) break;
      } catch (error) {
        if (isRepairLostVolumeError(error)) {
          repairLostImportedVolume = true;
          lastError = stepMeshFailureAfterRepairAttempt(standardLadderError, error);
        } else if (!repairLostImportedVolume) {
          lastError = error;
        }
      }
    }
  }

  if (best === undefined) {
    if (lastError instanceof Error) throw diagnoseStepMeshFailure(lastError);
    throw new StepGeometryError("Gmsh could not create a tetrahedral volume mesh from the STEP solid.");
  }
  const chosen = best;
  const refined = chosen.sizeMm !== undefined && requestedSizeMm !== undefined && chosen.sizeMm !== requestedSizeMm;
  const { sizeMm: _chosenSizeMm, preferQualityRepair: _preferQualityRepair, ...bestResult } = chosen;
  return {
    ...bestResult,
    totalMs: now() - totalStart,
    ...(refined
      ? {
          qualityRefinement: {
            requestedMeshSizeMm: requestedSizeMm!,
            usedMeshSizeMm: chosen.sizeMm!,
            triedMeshSizesMm: triedSizesMm,
            direction: chosen.sizeMm! < requestedSizeMm! ? "finer" : "coarser"
          }
        }
      : {})
  };
}

function qualityRepairSizes(requestedSizeMm: number | undefined): number[] {
  if (requestedSizeMm === undefined || !Number.isFinite(requestedSizeMm) || requestedSizeMm <= 0) return [];
  const first = Math.min(requestedSizeMm, MAX_QUALITY_REPAIR_SIZE_MM);
  const second = first * (5 / 6);
  return second > 0 && Math.abs(second - first) > 1e-9 ? [first, second] : [first];
}

const NETGEN_CRASH_ERROR_NAME = "NetgenOptimizerCrash";
const QUALITY_REPAIR_RECOMMENDED_ERROR_NAME = "StepQualityRepairRecommended";

type StepMeshCandidate = Omit<StepMeshResult, "totalMs"> & {
  /** Internal orchestration hint; deliberately removed from the public result. */
  preferQualityRepair?: boolean;
};

function isNetgenCrash(error: unknown): boolean {
  return error instanceof Error && error.name === NETGEN_CRASH_ERROR_NAME;
}

function qualityRepairRecommendedError(error: unknown): Error {
  const recommended = new Error(messageOf(error));
  recommended.name = QUALITY_REPAIR_RECOMMENDED_ERROR_NAME;
  return recommended;
}

function isQualityRepairRecommended(error: unknown): boolean {
  return error instanceof Error && error.name === QUALITY_REPAIR_RECOMMENDED_ERROR_NAME;
}

function isRepairLostVolumeError(error: unknown): error is Error {
  return error instanceof Error && error.name === STEP_GEOMETRY_REPAIR_LOST_VOLUME_ERROR_NAME;
}

/**
 * Keep the ordinary meshing failure as the primary diagnosis when bounded
 * healing destroys a volume that imported successfully. Exported from this
 * module so the orchestration rule can be regression-tested without relying
 * on one vendor-specific STEP fixture.
 */
export function stepMeshFailureAfterRepairAttempt(standardError: unknown, repairError: unknown): unknown {
  if (!isRepairLostVolumeError(repairError)) return repairError;
  if (!(standardError instanceof Error)) return repairError;
  return new StepGeometryError(
    `${messageOf(standardError)} Automatic geometry repair was also tried, but it could not re-close the model's faces within the bounded 0.05 mm sew tolerance and was discarded. ${FIX_OPEN_SURFACES_ACTION}`
  );
}

export function stepGeometryNoRepairedVolumeError(originalVolumeCount: number, toleranceMm: number): StepGeometryError {
  if (originalVolumeCount <= 0) {
    return new StepGeometryError("Open STEP surfaces remain after sewing and boundary patching; no solid volume could be created.");
  }
  const error = new StepGeometryError(
    `Automatic geometry repair could not re-close this model's faces (sew tolerance ${formatToleranceMm(toleranceMm)} mm), so the repaired attempt was discarded.`
  );
  error.name = STEP_GEOMETRY_REPAIR_LOST_VOLUME_ERROR_NAME;
  return error;
}

/**
 * Gmsh's 3D boundary recovery reports self-intersecting surface meshes with
 * TetGen's raw "PLC Error: A segment and a facet intersect at point" wording,
 * which gives the user nothing actionable. Translate that failure class into
 * an honest geometry diagnosis. The "Fix open surfaces" action is deliberately
 * not appended: the shell is closed — its faces cross each other — so sewing
 * advice would be wrong.
 */
const BOUNDARY_SELF_INTERSECTION_PATTERN = /PLC Error|segment and a facet intersect|facets intersect|self-?intersect/i;

export function diagnoseStepMeshFailure(error: Error): Error {
  if (!BOUNDARY_SELF_INTERSECTION_PATTERN.test(error.message)) return withStepGeometryAction(error);
  return new StepGeometryError(
    "Meshing failed because the model's surfaces pass through each other, so no valid volume boundary could be recovered. " +
      "This usually comes from overlapping solid bodies or a self-intersecting boolean result in the source CAD; re-export the part as a single fused solid. " +
      `(Mesher detail: ${error.message})`
  );
}

function withStepGeometryAction(error: Error): Error {
  if (error.name !== "StepGeometryError" && !isRepairLostVolumeError(error)) return error;
  if (error.message.includes("Fix open surfaces")) return error;
  return new StepGeometryError(`${error.message} ${FIX_OPEN_SURFACES_ACTION}`);
}

async function meshStepWithAlgorithmFallback(
  stepContent: Uint8Array | string,
  options: StepMeshWasmOptions,
  totalStart: number
): Promise<StepMeshCandidate> {
  const original = await meshStepAlgorithmCandidates(stepContent, options, totalStart, false);
  if (original.best !== undefined) {
    // A mesh below the floor is still valuable as the best candidate for the
    // outer size ladder, but only after both algorithms have had a chance.
    return original.best;
  }
  if (original.preferQualityRepair) {
    throw qualityRepairRecommendedFromAlgorithmFailures(original);
  }

  // A STEP file can look closed in the viewport while its OpenCASCADE shell
  // contains a tolerance gap, a degenerate wire, or a genuinely missing face.
  // Both 3D algorithms consume the same broken 1D/2D boundary, so changing
  // algorithms cannot repair this class of failure. Retry on fresh modules
  // after conservatively sewing/healing the B-rep. Automatic meshing never
  // invents a cap; boundary patching is reserved for the explicit Fix action.
  const repaired = await meshStepAlgorithmCandidates(stepContent, options, now(), true);
  if (repaired.best !== undefined) return repaired.best;
  throw new StepGeometryError(
    "STEP geometry has open or invalid surfaces, and automatic healing could not create a closed solid. " +
      `${FIX_OPEN_SURFACES_ACTION} ` +
      `(Original Delaunay: ${messageOf(original.delaunayError)}; original Frontal: ${messageOf(original.frontalError)}; ` +
      `healed Delaunay: ${messageOf(repaired.delaunayError)}; healed Frontal: ${messageOf(repaired.frontalError)})`
  );
}

type StepAlgorithmCandidates = {
  best?: StepMeshCandidate;
  delaunayError?: unknown;
  frontalError?: unknown;
  preferQualityRepair?: boolean;
};

function qualityRepairRecommendedFromAlgorithmFailures(candidates: StepAlgorithmCandidates): Error {
  const recommended = new Error(
    `Standard STEP meshing failed (Delaunay: ${messageOf(candidates.delaunayError)}; Frontal: ${messageOf(candidates.frontalError)}).`
  );
  recommended.name = QUALITY_REPAIR_RECOMMENDED_ERROR_NAME;
  return recommended;
}

async function meshStepAlgorithmCandidates(
  stepContent: Uint8Array | string,
  options: StepMeshWasmOptions,
  totalStart: number,
  repairGeometry: boolean
): Promise<StepAlgorithmCandidates> {
  let best: StepMeshCandidate | undefined;
  let delaunayError: unknown;
  let frontalError: unknown;
  let preferQualityRepair = false;

  for (const algorithm of ["delaunay", "frontal"] as const) {
    let result: StepMeshCandidate | undefined;
    try {
      result = meshStepSession(
        await loadGmshWasm(),
        stepContent,
        options,
        algorithm,
        algorithm === "delaunay" ? totalStart : now(),
        true,
        repairGeometry ? "automatic" : false
      );
    } catch (error) {
      if (algorithm === "delaunay") delaunayError = error;
      else frontalError = error;

      if (isQualityRepairRecommended(error)) {
        preferQualityRepair = true;
        // A thrown Delaunay boundary-recovery failure is exactly why Frontal
        // exists. Only a completed result carrying preferQualityRepair below
        // may skip the alternate algorithm; thrown candidates continue.
        continue;
      }

      // The Netgen optimizer can crash the wasm module outright ("memory
      // access out of bounds"). Retry the same algorithm on a fresh module,
      // but do not mistake a completed sub-floor mesh for a successful rescue.
      if (isNetgenCrash(error)) {
        try {
          result = meshStepSession(
            await loadGmshWasm(),
            stepContent,
            options,
            algorithm,
            now(),
            false,
            repairGeometry ? "automatic" : false
          );
        } catch (retryError) {
          if (algorithm === "delaunay") delaunayError = retryError;
          else frontalError = retryError;
          if (isQualityRepairRecommended(retryError)) preferQualityRepair = true;
        }
      }
    }

    if (result !== undefined) {
      if (best === undefined || qualityOf(result) > qualityOf(best)) best = result;
      if (meshResultPassesQuality(result)) return { best, delaunayError, frontalError };
      // A large solid with residual seam edges needs bounded OCC healing, not
      // another unhealed Frontal or characteristic-size attempt. Returning
      // this hint avoids retaining many fresh gmsh WASM heaps in one worker.
      if (result.preferQualityRepair) return { best, delaunayError, frontalError };
    }
  }

  return { best, delaunayError, frontalError, ...(preferQualityRepair ? { preferQualityRepair: true } : {}) };
}

function qualityOf(result: Pick<StepMeshResult, "qualityMinSICN">): number {
  return result.qualityMinSICN ?? -Infinity;
}

function meshResultPassesQuality(result: Pick<StepMeshResult, "qualityMinSICN">): boolean {
  const quality = result.qualityMinSICN;
  return quality !== undefined && quality >= MESH_QUALITY_REJECT_MIN_SICN;
}

/** Volume-element count from the declared msh2 `$Elements` records only. */
function countTetLines(msh: string): number {
  const lines = msh.split(/\r?\n/);
  const sectionStart = lines.findIndex((line) => line.trim() === "$Elements");
  if (sectionStart < 0) return 0;
  const declaredCount = Number.parseInt(lines[sectionStart + 1]?.trim() ?? "", 10);
  if (!Number.isFinite(declaredCount) || declaredCount < 0) return 0;
  let count = 0;
  for (let offset = 0; offset < declaredCount; offset += 1) {
    const fields = lines[sectionStart + 2 + offset]?.trim().split(/\s+/);
    if (fields?.[1] === "4" || fields?.[1] === "11") count += 1;
  }
  return count;
}

function meshStepSession(
  gmsh: GmshApi,
  stepContent: Uint8Array | string,
  options: StepMeshWasmOptions,
  algorithm3D: "delaunay" | "frontal",
  totalStart: number,
  allowNetgen: boolean,
  repairProfile: "automatic" | "quality" | false = false
): StepMeshCandidate {
  const timings: MeshTimings = {};
  let geometryRepair: StepGeometryRepairReport | undefined;
  let multiBodyFusion: StepMultiBodyFusionReport | undefined;
  let preferQualityRepair = false;
  timePhaseSync(timings, options, "init", totalStart, () => {
    gmsh.initialize();
    quietLogger(gmsh);
  });
  try {
    timePhaseSync(timings, options, "import", totalStart, () => {
      gmsh.FS.writeFile("/in.step", stepContent);
      if (algorithm3D === "frontal") gmsh.option.setNumber("Mesh.Algorithm3D", 4);
      if (repairProfile === "quality") {
        // MeshAdapt is materially more robust than Frontal-Delaunay around
        // healed sliver faces. Keep 3D Delaunay explicit so this profile is
        // deterministic even if gmsh changes an automatic default.
        gmsh.option.setNumber("Mesh.Algorithm", 1);
        gmsh.option.setNumber("Mesh.Algorithm3D", 1);
      }
      if (options.meshSizeMm !== undefined && options.meshSizeMm > 0) {
        gmsh.option.setNumber("Mesh.CharacteristicLengthMin", options.meshSizeMm * 0.45);
        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", options.meshSizeMm);
      }
      // Gmsh defaults `highestDimOnly` to true, which silently discards a
      // detached sheet whenever the same STEP also contains a solid. Import
      // every top-level shape so validation can reject those open surfaces.
      gmsh.model.occ.importShapes("/in.step", false);
      gmsh.model.occ.synchronize();
      if (options.structuralBodyBounds?.length) {
        retainStructuralStepVolumes(gmsh, options.structuralBodyBounds);
      }
      // A STEP file exported as several touching or overlapping solids meshes
      // per-volume into disconnected (or double-counted) tetrahedra that the
      // solver rejects as multiple components. Fuse them into one part up
      // front; genuinely disjoint bodies are left alone (the payload-body plan
      // and the connected-component check own that case).
      if (!options.preservePartIdentity) multiBodyFusion = fuseImportedStepVolumes(gmsh);
      const importedSurfaceCount = entityTags(gmsh, 2).length;
      const importedOpenBoundaryCurveCount = openBoundaryCurveTags(gmsh).length;
      preferQualityRepair = repairProfile === false &&
        importedSurfaceCount >= COMPLEX_SEAM_REPAIR_SURFACE_THRESHOLD &&
        importedOpenBoundaryCurveCount > 0;
      if (repairProfile) {
        geometryRepair = repairImportedStepGeometry(gmsh, repairProfile, false);
      }
      if (entityTags(gmsh, 3).length === 0) {
        throw new StepGeometryError("The STEP import contains surfaces but no closed solid volume.");
      }
      if (hasDegenerateVolumes(gmsh)) {
        throw new StepGeometryError("The STEP import contains a zero-volume or degenerate solid body.");
      }
      const orphanSurfaceCount = orphanSurfaceTags(gmsh).length;
      if (orphanSurfaceCount > 0) {
        throw new StepGeometryError(`The STEP import contains ${orphanSurfaceCount.toLocaleString()} surface ${orphanSurfaceCount === 1 ? "sheet" : "sheets"} that do not bound a solid volume.`);
      }
      // One physical group per geometric surface so the msh2 output keeps the
      // boundary triangles grouped per B-rep surface (`surface_<tag>` sets in
      // the parser) — the input the A-M3 facet->face attribution votes over.
      // Without physical groups gmsh writes physicalTag 0 for every element
      // and the parser collapses the whole boundary into one set.
      addPerSurfacePhysicalGroups(gmsh);
    });
    timePhaseSync(timings, options, "mesh2d", totalStart, () => gmsh.model.mesh.generate(2));
    timePhaseSync(timings, options, "mesh3d", totalStart, () => gmsh.model.mesh.generate(3));
    if (tetElementCount(gmsh) === 0) {
      // Query gmsh's volume element tables directly. Scanning the emitted MSH
      // can false-match physical group, node, or surface-element records whose
      // numeric tags happen to be 4 or 11.
      throw new StepGeometryError("Gmsh did not create any tetrahedra from the STEP solid.");
    }

    // Thin walls leave a tiny tail of sliver tets in the LINEAR mesh (often a
    // single element out of thousands) that no global size change reliably
    // removes — measured on a 1.5 mm sheet: minSICN 0.0115 raw vs 0.112 after
    // one Netgen pass (~50 ms), which locally splits/repairs exactly that
    // tail. Only run it when the mesh would otherwise fail the gate: Netgen
    // in gmsh-wasm can hard-crash the module on some meshes, which aborts the
    // session (caught upstream and retried without the optimizer).
    let optimizer: StepMeshResult["optimizer"];
    let linearQuality = minSICNQuality(gmsh);
    if (allowNetgen && !preferQualityRepair && linearQuality !== undefined && linearQuality < MESH_QUALITY_REJECT_MIN_SICN) {
      try {
        gmsh.model.mesh.optimize("Netgen");
      } catch (error) {
        const crash = new Error(`gmsh Netgen optimizer crashed: ${messageOf(error)}`);
        crash.name = NETGEN_CRASH_ERROR_NAME;
        throw crash;
      }
      optimizer = "netgen";
      linearQuality = minSICNQuality(gmsh);
    }

    let elevation: StepMeshResult["elevation"];
    let elementOrderFallback: StepMeshResult["elementOrderFallback"];
    if (
      options.elementOrder === 2 &&
      !(preferQualityRepair && linearQuality !== undefined && linearQuality < MESH_QUALITY_REJECT_MIN_SICN)
    ) {
      timePhaseSync(timings, options, "order2", totalStart, () => gmsh.model.mesh.setOrder(2));
      elevation = "curved";
    }
    let qualityMinSICN = options.elementOrder === 2 ? minSICNQuality(gmsh) : linearQuality;
    if (
      elevation === "curved" &&
      qualityMinSICN !== undefined &&
      qualityMinSICN < MESH_QUALITY_REJECT_MIN_SICN
    ) {
      // Curved elevation snaps Tet10 mid-side nodes onto the CAD surface,
      // which inverts elements on thin or bent regions (measured minSICN
      // -0.29 on a 3 mm bent shell whose linear mesh scores +0.31). Straight
      // re-elevation keeps quadratic elements with the linear mesh's quality
      // at the cost of linearized curved boundaries.
      gmsh.model.mesh.setOrder(1);
      gmsh.option.setNumber("Mesh.SecondOrderLinear", 1);
      gmsh.model.mesh.setOrder(2);
      qualityMinSICN = minSICNQuality(gmsh);
      elevation = "straight_edge";
    }
    if (options.elementOrder === 2) {
      const quadraticNodeCount = meshNodeCount(gmsh);
      if (quadraticNodeCount > MAX_BROWSER_SOLVE_NODES) {
        // A safe mesh that cannot enter the browser solver is not a useful
        // recovery. Retain the same corner-node tetrahedra as Tet4, recompute
        // quality, and expose the downgrade so callers can warn the user.
        gmsh.model.mesh.setOrder(1);
        qualityMinSICN = minSICNQuality(gmsh);
        elevation = undefined;
        elementOrderFallback = {
          requested: 2,
          used: 1,
          reason: "browser_dof_limit",
          quadraticNodeCount
        };
      }
    }
    const msh = timePhaseSync(timings, options, "write", totalStart, () => writeMshV2(gmsh));
    if (countTetLines(msh) === 0) {
      throw new StepGeometryError("Gmsh did not create any tetrahedra from the STEP solid.");
    }
    return {
      msh,
      timings,
      algorithm3D,
      ...(optimizer !== undefined ? { optimizer } : {}),
      ...(elevation !== undefined ? { elevation } : {}),
      ...(geometryRepair !== undefined ? { geometryRepair } : {}),
      ...(multiBodyFusion !== undefined ? { multiBodyFusion } : {}),
      ...(elementOrderFallback !== undefined ? { elementOrderFallback } : {}),
      ...(preferQualityRepair ? { preferQualityRepair: true } : {}),
      ...(qualityMinSICN !== undefined ? { qualityMinSICN } : {})
    };
  } catch (error) {
    if (preferQualityRepair) throw qualityRepairRecommendedError(error);
    throw error;
  } finally {
    safeFinalize(gmsh);
  }
}

/**
 * Fuse a multi-solid STEP import into as few volumes as OCC's boolean union
 * can produce. Touching bodies become one conformal solid; overlapping bodies
 * stop double-counting material. Disjoint bodies survive unchanged (the union
 * cannot merge them), and any boolean failure falls back to the un-fused
 * import so behavior degrades to the previous per-volume meshing.
 */
function fuseImportedStepVolumes(gmsh: GmshApi): StepMultiBodyFusionReport | undefined {
  const volumeTags = entityTags(gmsh, 3);
  if (volumeTags.length <= 1) return undefined;
  const [firstTag, ...restTags] = volumeTags;
  try {
    gmsh.model.occ.fuse([3, firstTag!], restTags.flatMap((tag) => [3, tag]));
    gmsh.model.occ.synchronize();
  } catch {
    try {
      gmsh.model.occ.synchronize();
    } catch {
      /* leave the import as-is */
    }
    return undefined;
  }
  const fusedVolumeCount = entityTags(gmsh, 3).length;
  if (fusedVolumeCount === 0 || fusedVolumeCount >= volumeTags.length) return undefined;
  return { inputVolumeCount: volumeTags.length, fusedVolumeCount };
}

function retainStructuralStepVolumes(gmsh: GmshApi, structuralBounds: StepBodyBounds[]): void {
  const volumeTags = entityTags(gmsh, 3);
  if (volumeTags.length === 0) return;
  if (structuralBounds.length >= volumeTags.length) return;

  const candidates = volumeTags.map((tag) => ({
    tag,
    bounds: boundsFromGmsh(gmsh.model.getBoundingBox(3, tag))
  }));
  const unmatched = new Set(volumeTags);
  const retained = new Set<number>();
  for (const target of structuralBounds) {
    const ranked = candidates
      .filter((candidate) => unmatched.has(candidate.tag))
      .map((candidate) => ({ candidate, score: stepBoundsMatchScore(target, candidate.bounds) }))
      .sort((left, right) => left.score - right.score);
    const best = ranked[0];
    if (!best || best.score > 0.1) {
      throw new StepGeometryError("Could not identify the selected structural body in the imported STEP model.");
    }
    retained.add(best.candidate.tag);
    unmatched.delete(best.candidate.tag);
  }

  const removeDimTags = volumeTags.filter((tag) => !retained.has(tag)).flatMap((tag) => [3, tag]);
  if (removeDimTags.length === 0) return;
  gmsh.model.occ.remove(removeDimTags, true);
  gmsh.model.occ.synchronize();
  if (entityTags(gmsh, 3).length !== retained.size) {
    throw new StepGeometryError("Could not isolate the selected structural STEP body for meshing.");
  }
}

function boundsFromGmsh(bounds: { xmin: number; ymin: number; zmin: number; xmax: number; ymax: number; zmax: number }): StepBodyBounds {
  return {
    min: [bounds.xmin, bounds.ymin, bounds.zmin],
    max: [bounds.xmax, bounds.ymax, bounds.zmax]
  };
}

function stepBoundsMatchScore(target: StepBodyBounds, candidate: StepBodyBounds): number {
  const targetCenter = boundsCenter(target);
  const candidateCenter = boundsCenter(candidate);
  const targetSize = boundsSize(target);
  const candidateSize = boundsSize(candidate);
  const scale = Math.max(Math.hypot(...targetSize), Math.hypot(...candidateSize), 1e-9);
  return (
    Math.hypot(
      targetCenter[0] - candidateCenter[0],
      targetCenter[1] - candidateCenter[1],
      targetCenter[2] - candidateCenter[2]
    ) +
    Math.hypot(
      targetSize[0] - candidateSize[0],
      targetSize[1] - candidateSize[1],
      targetSize[2] - candidateSize[2]
    )
  ) / scale;
}

function boundsCenter(bounds: StepBodyBounds): [number, number, number] {
  return [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2
  ];
}

function boundsSize(bounds: StepBodyBounds): [number, number, number] {
  return [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2]
  ];
}

/**
 * Inspect STEP topology in the same OpenCASCADE/Gmsh stack used by production
 * meshing. Generating only the surface mesh catches malformed face wires (the
 * exact "1D mesh ... not forming a closed loop" failure) without paying for a
 * tetrahedral mesh.
 */
export async function inspectStepGeometry(stepContent: Uint8Array | string): Promise<StepGeometryInspection> {
  const gmsh = await loadGmshWasm();
  gmsh.initialize();
  quietLogger(gmsh);
  try {
    gmsh.FS.writeFile("/inspect.step", stepContent);
    try {
      gmsh.model.occ.importShapes("/inspect.step", false);
      gmsh.model.occ.synchronize();
    } catch (error) {
      return {
        status: "invalid",
        volumeCount: 0,
        surfaceCount: 0,
        orphanSurfaceCount: 0,
        openBoundaryCurveCount: 0,
        surfaceMeshValid: false,
        repairable: false,
        issue: "import_failed",
        message: `STEP geometry could not be imported: ${messageOf(error)}`
      };
    }

    const volumeCount = entityTags(gmsh, 3).length;
    const surfaceCount = entityTags(gmsh, 2).length;
    const orphanSurfaceCount = orphanSurfaceTags(gmsh).length;
    const openBoundaryCurveCount = openBoundaryCurveTags(gmsh).length;
    let surfaceMeshValid = true;
    let surfaceMeshError = "";
    try {
      gmsh.model.mesh.generate(2);
    } catch (error) {
      surfaceMeshValid = false;
      surfaceMeshError = messageOf(error);
    }

    if (!surfaceMeshValid) {
      return {
        status: "open_shell",
        volumeCount,
        surfaceCount,
        orphanSurfaceCount,
        openBoundaryCurveCount,
        surfaceMeshValid,
        repairable: false,
        issue: "invalid_surface_loop",
        message: `Open or invalid STEP surface detected: ${surfaceMeshError}`
      };
    }
    if (volumeCount === 0) {
      return {
        status: "open_shell",
        volumeCount,
        surfaceCount,
        orphanSurfaceCount,
        openBoundaryCurveCount,
        surfaceMeshValid,
        repairable: false,
        issue: "no_solid_volume",
        message: "The STEP file contains an open surface shell instead of a closed solid volume."
      };
    }
    if (hasDegenerateVolumes(gmsh)) {
      return {
        status: "invalid",
        volumeCount,
        surfaceCount,
        orphanSurfaceCount,
        openBoundaryCurveCount,
        surfaceMeshValid,
        repairable: false,
        issue: "degenerate_volume",
        message: "The STEP file contains a zero-volume or degenerate solid body."
      };
    }
    if (orphanSurfaceCount > 0) {
      return {
        status: "open_shell",
        volumeCount,
        surfaceCount,
        orphanSurfaceCount,
        openBoundaryCurveCount,
        surfaceMeshValid,
        repairable: false,
        issue: "orphan_surfaces",
        message: `The STEP file contains ${orphanSurfaceCount.toLocaleString()} open surface ${orphanSurfaceCount === 1 ? "sheet" : "sheets"} that do not belong to a solid volume.`
      };
    }
    return {
      status: "solid",
      volumeCount,
      surfaceCount,
      orphanSurfaceCount: 0,
      // Periodic/seam curves on otherwise valid OCC solids do not always
      // cancel in getBoundary(combined=true). A real volume plus a successful
      // 2D mesh is the authoritative health gate; retain the count only as a
      // diagnostic instead of false-flagging healthy fillets/cylinders.
      openBoundaryCurveCount,
      surfaceMeshValid: true,
      repairable: false
    };
  } finally {
    safeFinalize(gmsh);
  }
}

/** Heal/sew an uploaded STEP shell, cap closed free-edge loops, and export it. */
export async function repairStepGeometry(stepContent: Uint8Array | string): Promise<StepGeometryRepairResult> {
  const gmsh = await loadGmshWasm();
  gmsh.initialize();
  quietLogger(gmsh);
  try {
    gmsh.FS.writeFile("/repair-input.step", stepContent);
    gmsh.model.occ.importShapes("/repair-input.step", false);
    gmsh.model.occ.synchronize();
    const repair = repairImportedStepGeometry(gmsh, "explicit", true);
    if (repair.repairedVolumeCount === 0) {
      throw new StepGeometryError("The open STEP surfaces could not be joined into a closed solid volume.");
    }
    try {
      gmsh.model.mesh.generate(2);
    } catch (error) {
      throw new StepGeometryError(`The repaired STEP still has an invalid surface loop: ${messageOf(error)}`);
    }
    gmsh.write("/repaired.step");
    const content = gmsh.FS.readFile("/repaired.step");
    const stepBytes = typeof content === "string" ? new TextEncoder().encode(content) : Uint8Array.from(content);
    return {
      stepContent: stepBytes,
      repair,
      inspection: {
        status: "solid",
        volumeCount: repair.repairedVolumeCount,
        surfaceCount: entityTags(gmsh, 2).length,
        orphanSurfaceCount: repair.repairedOrphanSurfaceCount,
        openBoundaryCurveCount: repair.repairedOpenBoundaryCurveCount,
        surfaceMeshValid: true,
        repairable: false
      }
    };
  } finally {
    safeFinalize(gmsh);
  }
}

const MAX_EXPLICIT_CAPS = 16;

function repairImportedStepGeometry(
  gmsh: GmshApi,
  profile: StepGeometryRepairReport["profile"],
  allowSurfacePatches: boolean
): StepGeometryRepairReport {
  const originalVolumeCount = entityTags(gmsh, 3).length;
  const originalOpenBoundaryCurveCount = openBoundaryCurveTags(gmsh).length;
  const originalOrphanSurfaceCount = orphanSurfaceTags(gmsh).length;
  const originalVolumeMm3 = occVolume(gmsh);
  const originalBoundsDiagonal = modelBoundingBoxDiagonal(gmsh);
  // STEP coordinates in this app are millimetres. Ordinary automatic repair
  // only closes exporter-scale cracks. Quality repair may remove sliver edges
  // up to 0.05 mm, but retains the strict automatic bounds/volume-change
  // guards and never invents a cap. The explicit profile is user-requested.
  const toleranceMm = profile === "automatic"
    ? Math.min(0.01, Math.max(1e-8, originalBoundsDiagonal * 1e-5))
    : Math.min(0.05, Math.max(1e-7, originalBoundsDiagonal * 1e-3));
  gmsh.model.occ.healShapes([], toleranceMm, true, true, true, true, true);
  gmsh.model.occ.synchronize();

  let cappedSurfaceCount = 0;
  // Surface filling invents geometry, so it is never part of the automatic
  // meshing fallback. It is reserved for the explicit Fix model action, whose
  // UI warns that the repaired shape must be reviewed and resets setup tied to
  // the old face ids.
  if (allowSurfacePatches && entityTags(gmsh, 3).length === 0) {
    const loops = orderedOpenBoundaryLoops(gmsh).slice(0, MAX_EXPLICIT_CAPS);
    for (const loop of loops) {
      try {
        const wire = gmsh.model.occ.addWire(loop, -1, true);
        try {
          // Preserve planar openings exactly whenever possible. Generic
          // surface filling can bow beyond the source bounds, so it is only a
          // fallback for genuinely non-planar boundary loops.
          gmsh.model.occ.addPlaneSurface([wire]);
        } catch {
          gmsh.model.occ.addSurfaceFilling(wire);
        }
        cappedSurfaceCount += 1;
      } catch {
        // Some free-edge graphs are not valid closed wires. Leave those for
        // the final validation, which returns a clear user-facing error.
      }
    }
    if (cappedSurfaceCount > 0) {
      gmsh.model.occ.healShapes([], toleranceMm, true, true, true, true, true);
      gmsh.model.occ.synchronize();
    }
  }

  const repairedVolumeCount = entityTags(gmsh, 3).length;
  const repairedOpenBoundaryCurveCount = openBoundaryCurveTags(gmsh).length;
  const repairedOrphanSurfaceCount = orphanSurfaceTags(gmsh).length;
  if (repairedVolumeCount === 0) {
    throw stepGeometryNoRepairedVolumeError(originalVolumeCount, toleranceMm);
  }
  if (repairedOrphanSurfaceCount > 0) {
    throw new StepGeometryError(`CAD healing left ${repairedOrphanSurfaceCount.toLocaleString()} open surface ${repairedOrphanSurfaceCount === 1 ? "sheet" : "sheets"} outside the repaired solid.`);
  }
  if (hasDegenerateVolumes(gmsh)) {
    throw new StepGeometryError("CAD healing produced one or more zero-volume or degenerate solid bodies.");
  }
  const repairedVolumeMm3 = occVolume(gmsh);
  const repairedBoundsDiagonal = modelBoundingBoxDiagonal(gmsh);
  const minimumMeaningfulVolumeMm3 = Math.max(repairedBoundsDiagonal ** 3 * 1e-12, 1e-12);
  if (repairedVolumeMm3 === undefined || repairedVolumeMm3 <= minimumMeaningfulVolumeMm3) {
    throw new StepGeometryError("CAD healing produced a zero-volume or degenerate solid, so the model is not safe to simulate.");
  }
  const relativeBoundsChange = relativeChange(originalBoundsDiagonal, repairedBoundsDiagonal);
  const relativeVolumeChange = originalVolumeMm3 !== undefined && repairedVolumeMm3 !== undefined
    ? relativeChange(originalVolumeMm3, repairedVolumeMm3)
    : undefined;
  const isAutomatic = profile !== "explicit";
  const maxBoundsChange = isAutomatic ? 0.005 : 0.02;
  const maxVolumeChange = isAutomatic ? 0.01 : 0.05;
  if (relativeBoundsChange > maxBoundsChange || (relativeVolumeChange !== undefined && relativeVolumeChange > maxVolumeChange)) {
    throw new StepGeometryError(
      `${isAutomatic ? "Automatic" : "Requested"} CAD healing changed the model too much (bounds ${(relativeBoundsChange * 100).toFixed(2)}%` +
        `${relativeVolumeChange !== undefined ? `, volume ${(relativeVolumeChange * 100).toFixed(2)}%` : ""}). ` +
        "Repair the source CAD and upload it again."
    );
  }
  return {
    method: cappedSurfaceCount > 0 ? "heal_and_cap" : "heal",
    profile,
    toleranceMm,
    cappedSurfaceCount,
    originalVolumeCount,
    repairedVolumeCount,
    originalOpenBoundaryCurveCount,
    repairedOpenBoundaryCurveCount,
    originalOrphanSurfaceCount,
    repairedOrphanSurfaceCount,
    ...(originalVolumeMm3 !== undefined ? { originalVolumeMm3 } : {}),
    ...(repairedVolumeMm3 !== undefined ? { repairedVolumeMm3 } : {}),
    ...(relativeVolumeChange !== undefined ? { relativeVolumeChange } : {}),
    relativeBoundsChange
  };
}

function occVolume(gmsh: GmshApi): number | undefined {
  const volumes = entityTags(gmsh, 3);
  if (volumes.length === 0) return undefined;
  try {
    return volumes.reduce((total, tag) => total + Math.abs(gmsh.model.occ.getMass(3, tag).mass), 0);
  } catch {
    return undefined;
  }
}

function hasDegenerateVolumes(gmsh: GmshApi): boolean {
  const volumes = entityTags(gmsh, 3);
  if (volumes.length === 0) return false;
  const minimumMeaningfulVolume = Math.max(modelBoundingBoxDiagonal(gmsh) ** 3 * 1e-12, 1e-12);
  try {
    return volumes.some((tag) => Math.abs(gmsh.model.occ.getMass(3, tag).mass) <= minimumMeaningfulVolume);
  } catch {
    return true;
  }
}

function relativeChange(before: number, after: number): number {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return Infinity;
  return Math.abs(after - before) / Math.max(Math.abs(before), 1e-12);
}

function modelBoundingBoxDiagonal(gmsh: GmshApi): number {
  try {
    const bounds = gmsh.model.getBoundingBox(-1, -1);
    return Math.max(Math.hypot(bounds.xmax - bounds.xmin, bounds.ymax - bounds.ymin, bounds.zmax - bounds.zmin), 1e-4);
  } catch {
    return 1;
  }
}

function openBoundaryCurveTags(gmsh: GmshApi): number[] {
  const surfaces = entityTags(gmsh, 2);
  if (surfaces.length === 0) return [];
  try {
    const boundary = gmsh.model.getBoundary(surfaces.flatMap((tag) => [2, tag]), true, true, false).outDimTags;
    const tags = new Set<number>();
    for (let index = 1; index < boundary.length; index += 2) tags.add(Math.abs(boundary[index]!));
    return [...tags];
  } catch {
    return [];
  }
}

function orphanSurfaceTags(gmsh: GmshApi): number[] {
  const allSurfaces = entityTags(gmsh, 2);
  if (allSurfaces.length === 0) return [];
  const volumeBoundarySurfaces = new Set<number>();
  for (const volumeTag of entityTags(gmsh, 3)) {
    try {
      for (const loop of gmsh.model.occ.getSurfaceLoops(volumeTag).surfaceTags) {
        for (const surfaceTag of loop) volumeBoundarySurfaces.add(Math.abs(surfaceTag));
      }
    } catch {
      // A volume whose OCC boundary cannot be queried is not safe to accept;
      // its surfaces remain absent from the set and are reported as orphaned.
    }
  }
  return allSurfaces.filter((tag) => !volumeBoundarySurfaces.has(tag));
}

function orderedOpenBoundaryLoops(gmsh: GmshApi): number[][] {
  const curveTags = openBoundaryCurveTags(gmsh);
  const endpoints = new Map<number, [number, number] | null>();
  const curvesAtPoint = new Map<number, number[]>();
  for (const curveTag of curveTags) {
    const boundary = gmsh.model.getBoundary([1, curveTag], false, false, false).outDimTags;
    const points: number[] = [];
    for (let index = 1; index < boundary.length; index += 2) {
      const point = Math.abs(boundary[index]!);
      if (!points.includes(point)) points.push(point);
    }
    if (points.length <= 1) {
      endpoints.set(curveTag, null); // A periodic curve is a complete loop by itself.
      continue;
    }
    const pair: [number, number] = [points[0]!, points[1]!];
    endpoints.set(curveTag, pair);
    for (const point of pair) curvesAtPoint.set(point, [...(curvesAtPoint.get(point) ?? []), curveTag]);
  }

  const unvisited = new Set(curveTags);
  const loops: number[][] = [];
  for (const startCurve of curveTags) {
    if (!unvisited.has(startCurve)) continue;
    const startEndpoints = endpoints.get(startCurve);
    if (startEndpoints === null) {
      unvisited.delete(startCurve);
      loops.push([startCurve]);
      continue;
    }
    if (!startEndpoints) continue;
    const [startPoint, nextPoint] = startEndpoints;
    const loop = [startCurve];
    unvisited.delete(startCurve);
    let currentPoint = nextPoint;
    let closed = currentPoint === startPoint;
    while (!closed && loop.length <= curveTags.length) {
      const nextCurve = (curvesAtPoint.get(currentPoint) ?? []).find((tag) => unvisited.has(tag));
      if (nextCurve === undefined) break;
      const nextEndpoints = endpoints.get(nextCurve);
      if (!nextEndpoints) break;
      loop.push(nextCurve);
      unvisited.delete(nextCurve);
      currentPoint = nextEndpoints[0] === currentPoint ? nextEndpoints[1] : nextEndpoints[0];
      closed = currentPoint === startPoint;
    }
    if (closed) loops.push(loop);
  }
  return loops;
}

function addPerSurfacePhysicalGroups(gmsh: GmshApi): void {
  for (const tag of entityTags(gmsh, 2)) {
    const physical = gmsh.model.addPhysicalGroup(2, [tag], -1);
    gmsh.model.setPhysicalName(2, physical, `surface_${tag}`);
  }
  // Volume group so gmsh still writes the volume elements once physical
  // groups exist (only physical entities are saved by default).
  const volumeTags = entityTags(gmsh, 3);
  if (volumeTags.length > 0) {
    const physical = gmsh.model.addPhysicalGroup(3, volumeTags, -1);
    gmsh.model.setPhysicalName(3, physical, "solid");
  }
}

function entityTags(gmsh: GmshApi, dimension: number): number[] {
  const flat = gmsh.model.getEntities(dimension).dimTags;
  const tags: number[] = [];
  for (let index = 1; index < flat.length; index += 2) {
    tags.push(flat[index]!);
  }
  return tags;
}

/**
 * Min signed inverse condition number across all volume elements, measured on
 * the final (possibly order-elevated) mesh. Best effort: quality queries are
 * diagnostics only, so any binding hiccup degrades to undefined.
 */
function minSICNQuality(gmsh: GmshApi): number | undefined {
  try {
    let min: number | undefined;
    for (const typeCode of [4, 11]) {
      const elements = gmsh.model.mesh.getElementsByType(typeCode);
      const tags = Array.from(elements.elementTags ?? []);
      if (tags.length === 0) continue;
      const qualities = gmsh.model.mesh.getElementQualities(tags, "minSICN").elementsQuality;
      for (const quality of qualities) {
        if (min === undefined || quality < min) min = quality;
      }
    }
    return min;
  } catch {
    return undefined;
  }
}

function tetElementCount(gmsh: GmshApi): number {
  let count = 0;
  for (const typeCode of [4, 11]) {
    count += gmsh.model.mesh.getElementsByType(typeCode).elementTags.length;
  }
  return count;
}

function meshNodeCount(gmsh: GmshApi): number {
  return gmsh.model.mesh.getNodes().nodeTags.length;
}

/**
 * Create a small STEP fixture (box with a cylindrical bore) using the OCC kernel.
 * Used once to generate the checked-in test fixture; kept exported so the spike
 * can regenerate it deterministically.
 */
export async function generateBoxWithBoreStep(dimensions: { x: number; y: number; z: number; boreDiameter: number }): Promise<string> {
  const gmsh = await loadGmshWasm();
  gmsh.initialize();
  quietLogger(gmsh);
  try {
    const { x, y, z, boreDiameter } = dimensions;
    const box = gmsh.model.occ.addBox(0, 0, 0, x, y, z);
    // Bore through the part along Z, overshooting both faces so the boolean
    // cut never has to resolve coincident surfaces at the cylinder ends.
    const bore = gmsh.model.occ.addCylinder(x / 2, y / 2, -1, 0, 0, z + 2, boreDiameter / 2);
    gmsh.model.occ.cut([3, box], [3, bore]);
    gmsh.model.occ.synchronize();
    gmsh.write("/fixture.step");
    return gmsh.FS.readFile("/fixture.step", { encoding: "utf8" }) as string;
  } finally {
    safeFinalize(gmsh);
  }
}

function writeMshV2(gmsh: GmshApi): string {
  gmsh.option.setNumber("Mesh.MshFileVersion", 2.2);
  gmsh.write("/out.msh");
  return gmsh.FS.readFile("/out.msh", { encoding: "utf8" }) as string;
}

function quietLogger(gmsh: GmshApi): void {
  // 2 = warnings and errors only; keeps worker/test output readable.
  gmsh.option.setNumber("General.Terminal", 0);
  gmsh.option.setNumber("General.Verbosity", 2);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatToleranceMm(toleranceMm: number): string {
  return Number(toleranceMm.toPrecision(6)).toString();
}

function safeFinalize(gmsh: GmshApi): void {
  try {
    gmsh.finalize();
  } catch {
    // finalize after a hard meshing failure can itself throw; the next
    // initialize() starts a fresh session either way.
  }
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function timePhaseSync<T>(timings: MeshTimings, options: MeshWasmOptions, phase: MeshPhase, totalStart: number, run: () => T): T {
  const start = now();
  const result = run();
  timings[phase] = now() - start;
  options.onPhase?.({ phase, elapsedMs: now() - totalStart });
  return result;
}

async function timePhase<T>(timings: MeshTimings, options: MeshWasmOptions, phase: MeshPhase, totalStart: number, run: () => Promise<T>): Promise<T> {
  const start = now();
  const result = await run();
  timings[phase] = now() - start;
  options.onPhase?.({ phase, elapsedMs: now() - totalStart });
  return result;
}
