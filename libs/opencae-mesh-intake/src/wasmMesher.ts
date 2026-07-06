// Drives @loumalouomega/gmsh-wasm (gmsh compiled to WebAssembly) to produce
// msh v2.2 volume meshes entirely in-process (MEMFS only — no child processes,
// no real filesystem), so the same code runs in Node tests and browser workers.
//
// The WASM module is lazy-loaded via dynamic import so browser bundles only pay
// for it when meshing actually starts (the .wasm asset is ~44 MB).

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
};

export type StepMeshResult = GeoMeshResult & {
  /** Which 3D algorithm produced the mesh: gmsh default Delaunay, or the Frontal fallback. */
  algorithm3D: "delaunay" | "frontal";
};

let gmshApiPromise: Promise<GmshApi> | null = null;

/** Load (and cache) the gmsh WASM module. Safe to call repeatedly. */
export async function loadGmshWasm(): Promise<GmshApi> {
  if (!gmshApiPromise) {
    gmshApiPromise = import("@loumalouomega/gmsh-wasm").then((mod) => mod.default());
  }
  return gmshApiPromise;
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
    const msh = timePhaseSync(timings, options, "write", totalStart, () => writeMshV2(gmsh));
    return { msh, timings, totalMs: now() - totalStart };
  } finally {
    safeFinalize(gmsh);
  }
}

/**
 * Import a STEP file through the OpenCASCADE kernel and volume-mesh it to msh v2.2.
 *
 * The single-threaded WASM build of gmsh has a documented weakness in the default
 * Delaunay 3D algorithm's boundary recovery; when generate(3) fails we retry the
 * whole session with Mesh.Algorithm3D = 4 (Frontal) and report which one won.
 */
export async function meshStepToMshV2(stepContent: Uint8Array | string, options: StepMeshWasmOptions = {}): Promise<StepMeshResult> {
  const totalStart = now();
  const gmsh = await loadGmshWasm();
  try {
    const first = meshStepSession(gmsh, stepContent, options, "delaunay", totalStart);
    return { ...first, totalMs: now() - totalStart };
  } catch (delaunayError) {
    // Retry once with the Frontal algorithm in a fresh session.
    try {
      const retryStart = now();
      const second = meshStepSession(gmsh, stepContent, options, "frontal", retryStart);
      return { ...second, totalMs: now() - totalStart };
    } catch (frontalError) {
      throw new Error(
        `gmsh-wasm STEP meshing failed with both 3D algorithms. Delaunay: ${messageOf(delaunayError)}; Frontal: ${messageOf(frontalError)}`
      );
    }
  }
}

function meshStepSession(
  gmsh: GmshApi,
  stepContent: Uint8Array | string,
  options: StepMeshWasmOptions,
  algorithm3D: "delaunay" | "frontal",
  totalStart: number
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
    });
    timePhaseSync(timings, options, "mesh2d", totalStart, () => gmsh.model.mesh.generate(2));
    timePhaseSync(timings, options, "mesh3d", totalStart, () => gmsh.model.mesh.generate(3));
    if (options.elementOrder === 2) {
      timePhaseSync(timings, options, "order2", totalStart, () => gmsh.model.mesh.setOrder(2));
    }
    const msh = timePhaseSync(timings, options, "write", totalStart, () => writeMshV2(gmsh));
    return { msh, timings, algorithm3D };
  } finally {
    safeFinalize(gmsh);
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
