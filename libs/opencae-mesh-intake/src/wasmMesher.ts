// Drives @loumalouomega/gmsh-wasm (gmsh compiled to WebAssembly) to produce
// msh v2.2 volume meshes entirely in-process (MEMFS only — no child processes,
// no real filesystem), so the same code runs in Node tests and browser workers.
//
// The WASM module is lazy-loaded via dynamic import so browser bundles only pay
// for it when meshing actually starts (the .wasm asset is ~44 MB).

import { MESH_QUALITY_REJECT_MIN_SICN } from "./meshQualityGate";

type GmshWasmModule = typeof import("@loumalouomega/gmsh-wasm");
export type GmshApi = Awaited<ReturnType<GmshWasmModule["default"]>>;

export type MeshPhase = "load" | "init" | "import" | "mesh2d" | "mesh3d" | "order2" | "write";
export type MeshPhaseEvent = { phase: MeshPhase; elapsedMs: number };
export type MeshTimings = Partial<Record<MeshPhase, number>>;

export type MeshWasmOptions = {
  elementOrder?: 1 | 2;
  onPhase?: (event: MeshPhaseEvent) => void;
};

export type StepMeshWasmOptions = MeshWasmOptions & {
  /** Characteristic mesh size in the STEP file's model units (our fixtures are mm). */
  meshSizeMm?: number;
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
   * mesh was automatically retried at finer characteristic lengths.
   */
  qualityRefinement?: {
    requestedMeshSizeMm: number;
    usedMeshSizeMm: number;
    triedMeshSizesMm: number[];
  };
};

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

/** Each quality refinement multiplies the characteristic length by this. */
const QUALITY_REFINEMENT_FACTOR = 2 / 3;
/** Extra mesh attempts at finer sizes when the quality floor is missed. */
const MAX_QUALITY_REFINEMENTS = 2;
/** Stop refining once a mesh gets this large — the solver caps DOF anyway. */
const MAX_QUALITY_REFINEMENT_TETS = 80_000;

/**
 * Import a STEP file through the OpenCASCADE kernel and volume-mesh it to msh v2.2.
 *
 * Two layers of robustness, both measured on real thin-walled parts:
 * - The single-threaded WASM build of gmsh has a documented weakness in the
 *   default Delaunay 3D algorithm's boundary recovery; when generate(3) fails
 *   the session retries with Mesh.Algorithm3D = 4 (Frontal).
 * - Thin walls produce sliver tets whose quality is NON-monotonic in mesh
 *   size (a 2 mm-wall clip scores minSICN 0.02 at 12 mm, 0.009 at 6 mm, but
 *   0.25 at 8 mm), so when a session misses the quality-gate floor the whole
 *   mesh is retried at 2/3 the size, up to two steps, and the first size that
 *   passes wins. The refinement ladder is recorded on the result so callers
 *   can surface it honestly.
 */
export async function meshStepToMshV2(stepContent: Uint8Array | string, options: StepMeshWasmOptions = {}): Promise<StepMeshResult> {
  const totalStart = now();
  const requestedSizeMm = options.meshSizeMm;
  let best: (Omit<StepMeshResult, "totalMs"> & { sizeMm?: number }) | undefined;
  const triedSizesMm: number[] = [];

  for (let attempt = 0; attempt <= MAX_QUALITY_REFINEMENTS; attempt += 1) {
    const sizeMm = requestedSizeMm !== undefined && requestedSizeMm > 0
      ? requestedSizeMm * QUALITY_REFINEMENT_FACTOR ** attempt
      : undefined;
    if (sizeMm !== undefined) triedSizesMm.push(sizeMm);
    const result = await meshStepWithAlgorithmFallback(stepContent, { ...options, meshSizeMm: sizeMm }, totalStart);
    if (best === undefined || (result.qualityMinSICN ?? -Infinity) > (best.qualityMinSICN ?? -Infinity)) {
      best = { ...result, sizeMm };
    }
    const quality = result.qualityMinSICN;
    if (quality !== undefined && quality >= MESH_QUALITY_REJECT_MIN_SICN) break; // Passes the gate — stop refining.
    if (sizeMm === undefined) break; // No size hint to refine against.
    if (countTetLines(result.msh) > MAX_QUALITY_REFINEMENT_TETS) break;
  }

  const chosen = best!;
  const refined = chosen.sizeMm !== undefined && requestedSizeMm !== undefined && chosen.sizeMm !== requestedSizeMm;
  const { sizeMm: _chosenSizeMm, ...bestResult } = chosen;
  return {
    ...bestResult,
    totalMs: now() - totalStart,
    ...(refined
      ? { qualityRefinement: { requestedMeshSizeMm: requestedSizeMm!, usedMeshSizeMm: chosen.sizeMm!, triedMeshSizesMm: triedSizesMm } }
      : {})
  };
}

const NETGEN_CRASH_ERROR_NAME = "NetgenOptimizerCrash";

function isNetgenCrash(error: unknown): boolean {
  return error instanceof Error && error.name === NETGEN_CRASH_ERROR_NAME;
}

async function meshStepWithAlgorithmFallback(
  stepContent: Uint8Array | string,
  options: StepMeshWasmOptions,
  totalStart: number
): Promise<Omit<StepMeshResult, "totalMs">> {
  const gmsh = await loadGmshWasm();
  try {
    return meshStepSession(gmsh, stepContent, options, "delaunay", totalStart, true);
  } catch (delaunayError) {
    // The Netgen optimizer can crash the wasm module outright ("memory access
    // out of bounds") on some meshes; the whole session is poisoned, so retry
    // the same algorithm on a FRESH module without the optimizer.
    if (isNetgenCrash(delaunayError)) {
      try {
        return meshStepSession(await loadGmshWasm(), stepContent, options, "delaunay", now(), false);
      } catch {
        // Fall through to the Frontal fallback below.
      }
    }
    // Retry once with the Frontal algorithm on a FRESH module instance — a
    // second session on the same instance aborts in gmsh-wasm 0.1.2.
    try {
      return meshStepSession(await loadGmshWasm(), stepContent, options, "frontal", now(), true);
    } catch (frontalError) {
      if (isNetgenCrash(frontalError)) {
        return meshStepSession(await loadGmshWasm(), stepContent, options, "frontal", now(), false);
      }
      throw new Error(
        `gmsh-wasm STEP meshing failed with both 3D algorithms. Delaunay: ${messageOf(delaunayError)}; Frontal: ${messageOf(frontalError)}`
      );
    }
  }
}

/** Cheap volume-element count from msh2 text (element type 4 = Tet4, 11 = Tet10). */
function countTetLines(msh: string): number {
  let count = 0;
  for (const line of msh.split("\n")) {
    const firstSpace = line.indexOf(" ");
    if (firstSpace <= 0) continue;
    const rest = line.slice(firstSpace + 1);
    if (rest.startsWith("4 ") || rest.startsWith("11 ")) count += 1;
  }
  return count;
}

function meshStepSession(
  gmsh: GmshApi,
  stepContent: Uint8Array | string,
  options: StepMeshWasmOptions,
  algorithm3D: "delaunay" | "frontal",
  totalStart: number,
  allowNetgen: boolean
): Omit<StepMeshResult, "totalMs"> {
  const timings: MeshTimings = {};
  timePhaseSync(timings, options, "init", totalStart, () => {
    gmsh.initialize();
    quietLogger(gmsh);
  });
  try {
    timePhaseSync(timings, options, "import", totalStart, () => {
      gmsh.FS.writeFile("/in.step", stepContent);
      if (algorithm3D === "frontal") gmsh.option.setNumber("Mesh.Algorithm3D", 4);
      if (options.meshSizeMm !== undefined && options.meshSizeMm > 0) {
        gmsh.option.setNumber("Mesh.CharacteristicLengthMin", options.meshSizeMm * 0.45);
        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", options.meshSizeMm);
      }
      gmsh.model.occ.importShapes("/in.step");
      gmsh.model.occ.synchronize();
      // One physical group per geometric surface so the msh2 output keeps the
      // boundary triangles grouped per B-rep surface (`surface_<tag>` sets in
      // the parser) — the input the A-M3 facet->face attribution votes over.
      // Without physical groups gmsh writes physicalTag 0 for every element
      // and the parser collapses the whole boundary into one set.
      addPerSurfacePhysicalGroups(gmsh);
    });
    timePhaseSync(timings, options, "mesh2d", totalStart, () => gmsh.model.mesh.generate(2));
    timePhaseSync(timings, options, "mesh3d", totalStart, () => gmsh.model.mesh.generate(3));

    // Thin walls leave a tiny tail of sliver tets in the LINEAR mesh (often a
    // single element out of thousands) that no global size change reliably
    // removes — measured on a 1.5 mm sheet: minSICN 0.0115 raw vs 0.112 after
    // one Netgen pass (~50 ms), which locally splits/repairs exactly that
    // tail. Only run it when the mesh would otherwise fail the gate: Netgen
    // in gmsh-wasm can hard-crash the module on some meshes, which aborts the
    // session (caught upstream and retried without the optimizer).
    let optimizer: StepMeshResult["optimizer"];
    let linearQuality = minSICNQuality(gmsh);
    if (allowNetgen && linearQuality !== undefined && linearQuality < MESH_QUALITY_REJECT_MIN_SICN) {
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
    if (options.elementOrder === 2) {
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
    const msh = timePhaseSync(timings, options, "write", totalStart, () => writeMshV2(gmsh));
    return {
      msh,
      timings,
      algorithm3D,
      ...(optimizer !== undefined ? { optimizer } : {}),
      ...(elevation !== undefined ? { elevation } : {}),
      ...(qualityMinSICN !== undefined ? { qualityMinSICN } : {})
    };
  } finally {
    safeFinalize(gmsh);
  }
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
  gmsh.option.setNumber("General.Verbosity", 2);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
