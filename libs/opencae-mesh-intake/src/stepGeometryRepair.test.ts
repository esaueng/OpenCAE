import { beforeAll, describe, expect, it } from "vitest";
import { parseGmshMeshToCoreVolumeMesh } from "./gmshMeshParser";
import {
  inspectStepGeometry,
  loadGmshWasm,
  meshStepToMshV2,
  repairStepGeometry,
  STEP_GEOMETRY_REPAIR_LOST_VOLUME_ERROR_NAME,
  stepGeometryNoRepairedVolumeError,
  stepMeshFailureAfterRepairAttempt,
  StepGeometryError,
  type GmshApi
} from "./wasmMesher";

type Point3 = readonly [x: number, y: number, z: number];

const BOX = { width: 12, depth: 10, height: 8 } as const;
const AUTOMATIC_GAP_MM = 0.00005;

let healthyBoxWithBoreStep: string;
let smallGapShellStep: string;
let missingTopShellStep: string;
let singleSheetStep: string;
let solidWithOrphanSheetStep: string;
let trayWithDisconnectedPayloadStep: string;

describe("STEP geometry inspection and repair", () => {
  beforeAll(async () => {
    healthyBoxWithBoreStep = await createStep((gmsh) => {
      const box = gmsh.model.occ.addBox(0, 0, 0, 24, 18, 10);
      const bore = gmsh.model.occ.addCylinder(12, 9, -1, 0, 0, 12, 2.5);
      gmsh.model.occ.cut([3, box], [3, bore]);
      gmsh.model.occ.synchronize();
    });
    smallGapShellStep = await createStep((gmsh) => {
      addBoxShellFaces(gmsh, { topZ: BOX.height + AUTOMATIC_GAP_MM, includeTop: true });
      gmsh.model.occ.synchronize();
    });
    missingTopShellStep = await createStep((gmsh) => {
      addBoxShellFaces(gmsh, { topZ: BOX.height, includeTop: false });
      gmsh.model.occ.synchronize();
    });
    singleSheetStep = await createStep((gmsh) => {
      addPlanarFace(gmsh, [
        [0, 0, 0],
        [BOX.width, 0, 0],
        [BOX.width, BOX.depth, 0],
        [0, BOX.depth, 0]
      ]);
      gmsh.model.occ.synchronize();
    });
    solidWithOrphanSheetStep = await createStep((gmsh) => {
      gmsh.model.occ.addBox(0, 0, 0, BOX.width, BOX.depth, BOX.height);
      addPlanarFace(gmsh, [
        [0, 0, BOX.height + 10],
        [BOX.width, 0, BOX.height + 10],
        [BOX.width, BOX.depth, BOX.height + 10],
        [0, BOX.depth, BOX.height + 10]
      ]);
      gmsh.model.occ.synchronize();
    });
    trayWithDisconnectedPayloadStep = await createStep((gmsh) => {
      gmsh.model.occ.addBox(0, 0, 0, 20, 16, 4);
      gmsh.model.occ.addBox(6, 5, 8, 8, 6, 12);
      gmsh.model.occ.synchronize();
    });
  }, 180_000);

  it("keeps a healthy box-with-bore solid and meshes it without geometry repair", { timeout: 180_000 }, async () => {
    const inspection = await inspectStepGeometry(healthyBoxWithBoreStep);

    expect(inspection).toMatchObject({
      status: "solid",
      volumeCount: 1,
      surfaceMeshValid: true,
      repairable: false
    });

    const meshed = await meshStepToMshV2(healthyBoxWithBoreStep, { meshSizeMm: 4 });
    expect(meshed).not.toHaveProperty("geometryRepair");
    expect(tetrahedronCount(meshed.msh)).toBeGreaterThan(0);
  });

  it("automatically heals a six-face shell with an exporter-scale gap and produces tetrahedra", { timeout: 180_000 }, async () => {
    const inspection = await inspectStepGeometry(smallGapShellStep);

    expect(inspection).toMatchObject({
      status: "open_shell",
      volumeCount: 0,
      surfaceCount: 6,
      surfaceMeshValid: true,
      issue: "no_solid_volume"
    });
    expect(inspection.openBoundaryCurveCount).toBeGreaterThan(0);

    const meshed = await meshStepToMshV2(smallGapShellStep, { meshSizeMm: 3 });
    expect(tetrahedronCount(meshed.msh)).toBeGreaterThan(0);
    expect(meshed.geometryRepair).toMatchObject({
      method: "heal",
      profile: "automatic",
      cappedSurfaceCount: 0,
      originalVolumeCount: 0,
      repairedVolumeCount: 1
    });
    expect(meshed.geometryRepair?.toleranceMm).toBeGreaterThan(AUTOMATIC_GAP_MM);
  });

  it("explicitly caps and repairs a box shell with its top face missing", { timeout: 180_000 }, async () => {
    const inspection = await inspectStepGeometry(missingTopShellStep);
    expect(inspection).toMatchObject({
      status: "open_shell",
      volumeCount: 0,
      surfaceCount: 5,
      surfaceMeshValid: true,
      issue: "no_solid_volume"
    });

    const repaired = await repairStepGeometry(missingTopShellStep);
    expect(repaired.repair).toMatchObject({
      method: "heal_and_cap",
      profile: "explicit",
      cappedSurfaceCount: 1,
      originalVolumeCount: 0,
      repairedVolumeCount: 1
    });
    expect(repaired.inspection).toMatchObject({
      status: "solid",
      volumeCount: 1,
      surfaceMeshValid: true,
      repairable: false
    });

    const reinspection = await inspectStepGeometry(repaired.stepContent);
    expect(reinspection).toMatchObject({ status: "solid", volumeCount: 1, surfaceMeshValid: true });
  });

  it("rejects a standalone sheet as unrepairable with a typed geometry error", { timeout: 180_000 }, async () => {
    const inspection = await inspectStepGeometry(singleSheetStep);
    expect(inspection).toMatchObject({
      status: "open_shell",
      volumeCount: 0,
      surfaceCount: 1,
      surfaceMeshValid: true,
      repairable: false,
      issue: "no_solid_volume"
    });

    await expect(repairStepGeometry(singleSheetStep)).rejects.toBeInstanceOf(StepGeometryError);
    await expect(meshStepToMshV2(singleSheetStep, { meshSizeMm: 3 })).rejects.toMatchObject({
      name: "StepGeometryError",
      message: expect.stringContaining("Use Fix open surfaces on the Model step")
    });
  });

  it("keeps the standard mesh failure first when bounded healing loses an imported volume", () => {
    const standardError = new StepGeometryError("Gmsh failed to create the 3D mesh for the imported solid.");
    const repairError = stepGeometryNoRepairedVolumeError(1, 0.05);

    const composed = stepMeshFailureAfterRepairAttempt(standardError, repairError);

    expect(composed).toBeInstanceOf(StepGeometryError);
    expect(composed).toMatchObject({
      name: "StepGeometryError",
      message: expect.stringMatching(/^Gmsh failed to create the 3D mesh for the imported solid\./)
    });
    expect((composed as Error).message).toContain("Automatic geometry repair was also tried");
    expect((composed as Error).message).toContain("was discarded");
    expect((composed as Error).message).toContain("Use Fix open surfaces on the Model step");
    expect((composed as Error).message).not.toContain(repairError.message);
  });

  it("keeps the no-solid-volume diagnosis when the import never contained a volume", () => {
    const error = stepGeometryNoRepairedVolumeError(0, 0.05);

    expect(error).toMatchObject({
      name: "StepGeometryError",
      message: "Open STEP surfaces remain after sewing and boundary patching; no solid volume could be created."
    });
    expect(error.name).not.toBe(STEP_GEOMETRY_REPAIR_LOST_VOLUME_ERROR_NAME);
  });

  it("rejects a valid solid accompanied by a disconnected surface sheet", { timeout: 180_000 }, async () => {
    const inspection = await inspectStepGeometry(solidWithOrphanSheetStep);
    expect(inspection).toMatchObject({
      status: "open_shell",
      volumeCount: 1,
      orphanSurfaceCount: 1,
      surfaceMeshValid: true,
      repairable: false,
      issue: "orphan_surfaces"
    });

    await expect(repairStepGeometry(solidWithOrphanSheetStep)).rejects.toBeInstanceOf(StepGeometryError);
    await expect(meshStepToMshV2(solidWithOrphanSheetStep, { meshSizeMm: 3 })).rejects.toBeInstanceOf(StepGeometryError);
  });

  it("retains only the selected structural body when a STEP also contains disconnected payload solids", { timeout: 180_000 }, async () => {
    const inspection = await inspectStepGeometry(trayWithDisconnectedPayloadStep);
    expect(inspection).toMatchObject({ status: "solid", volumeCount: 2 });

    const meshed = await meshStepToMshV2(trayWithDisconnectedPayloadStep, {
      elementOrder: 1,
      meshSizeMm: 4,
      structuralBodyBounds: [{ min: [0, 0, 0], max: [20, 16, 4] }]
    });
    const artifact = parseGmshMeshToCoreVolumeMesh(meshed.msh, { units: "mm" });
    expect(artifact.metadata.connectedComponentCount).toBe(1);
    const coordinates = artifact.nodes.coordinates;
    const xs = Array.from({ length: coordinates.length / 3 }, (_value, index) => coordinates[index * 3]!);
    const ys = Array.from({ length: coordinates.length / 3 }, (_value, index) => coordinates[index * 3 + 1]!);
    const zs = Array.from({ length: coordinates.length / 3 }, (_value, index) => coordinates[index * 3 + 2]!);
    expect(Math.min(...xs)).toBeCloseTo(0, 8);
    expect(Math.max(...xs)).toBeCloseTo(0.02, 8);
    expect(Math.min(...ys)).toBeCloseTo(0, 8);
    expect(Math.max(...ys)).toBeCloseTo(0.016, 8);
    expect(Math.min(...zs)).toBeCloseTo(0, 8);
    expect(Math.max(...zs)).toBeCloseTo(0.004, 8);
  });
});

async function createStep(build: (gmsh: GmshApi) => void): Promise<string> {
  const gmsh = await loadGmshWasm();
  gmsh.initialize();
  gmsh.option.setNumber("General.Verbosity", 2);
  try {
    build(gmsh);
    gmsh.write("/generated.step");
    return gmsh.FS.readFile("/generated.step", { encoding: "utf8" }) as string;
  } finally {
    try {
      gmsh.finalize();
    } catch {
      // gmsh-wasm instances are single-use; discard this one even if OCC cleanup fails.
    }
  }
}

function addBoxShellFaces(
  gmsh: GmshApi,
  options: { topZ: number; includeTop: boolean }
): void {
  const { width, depth, height } = BOX;
  const { topZ, includeTop } = options;

  // Each face intentionally owns separate edge/point topology, as happens in
  // imperfect CAD exports. OCC must sew the coincident edges during repair.
  addPlanarFace(gmsh, [[0, 0, 0], [0, depth, 0], [width, depth, 0], [width, 0, 0]]); // bottom
  addPlanarFace(gmsh, [[0, 0, 0], [width, 0, 0], [width, 0, height], [0, 0, height]]); // front
  addPlanarFace(gmsh, [[0, depth, 0], [0, depth, height], [width, depth, height], [width, depth, 0]]); // back
  addPlanarFace(gmsh, [[0, 0, 0], [0, 0, height], [0, depth, height], [0, depth, 0]]); // left
  addPlanarFace(gmsh, [[width, 0, 0], [width, depth, 0], [width, depth, height], [width, 0, height]]); // right
  if (includeTop) {
    addPlanarFace(gmsh, [[0, 0, topZ], [width, 0, topZ], [width, depth, topZ], [0, depth, topZ]]);
  }
}

function addPlanarFace(gmsh: GmshApi, points: readonly [Point3, Point3, Point3, Point3]): void {
  const pointTags = points.map(([x, y, z]) => gmsh.model.occ.addPoint(x, y, z));
  const curves = pointTags.map((start, index) => gmsh.model.occ.addLine(start, pointTags[(index + 1) % pointTags.length]!));
  const wire = gmsh.model.occ.addWire(curves, -1, true);
  gmsh.model.occ.addPlaneSurface([wire]);
}

function tetrahedronCount(msh: string): number {
  const artifact = parseGmshMeshToCoreVolumeMesh(msh, {
    units: "mm",
    diagnostics: ["STEP geometry repair regression"]
  });
  return artifact.elements.length;
}
