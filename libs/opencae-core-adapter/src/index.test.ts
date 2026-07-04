import { describe, expect, test } from "vitest";
import { solverSurfaceMeshFromModel } from "@opencae/core";
import { solveCoreStatic } from "@opencae/solver-cpu";
import type { DisplayModel, Study } from "@opencae/schema";
import {
  bracketMeshSizeMmForPreset,
  buildOpenCaeCoreCloudModelForStudy,
  cloudGeometrySourceForStudy,
  displayDirectionToSolverFrame,
  studyForCoreCloudGeometryDispatch,
  trySolveOpenCaeCoreStudy
} from "./index";

function studyFixture(overrides: Partial<Study> = {}): Study {
  return {
    id: "study-1",
    projectId: "project-1",
    name: "Static Stress",
    type: "static_stress",
    geometryScope: [{ bodyId: "body-1", entityType: "body", entityId: "body-1", label: "Cantilever" }],
    materialAssignments: [{ id: "assign-1", materialId: "mat-aluminum-6061", selectionRef: "selection-body-1", parameters: {}, status: "complete" }],
    namedSelections: [
      {
        id: "selection-fixed-face",
        name: "Fixed end face",
        entityType: "face",
        geometryRefs: [{ bodyId: "body-1", entityType: "face", entityId: "face-base-left", label: "Fixed end face" }],
        fingerprint: "fixed-face"
      },
      {
        id: "selection-load-face",
        name: "Free end load face",
        entityType: "face",
        geometryRefs: [{ bodyId: "body-1", entityType: "face", entityId: "face-load-top", label: "Free end load face" }],
        fingerprint: "load-face"
      }
    ],
    contacts: [],
    constraints: [{ id: "constraint-1", type: "fixed", selectionRef: "selection-fixed-face", parameters: {}, status: "complete" }],
    loads: [{ id: "load-1", type: "force", selectionRef: "selection-load-face", parameters: { value: 500, units: "N", direction: [0, 0, -1] }, status: "complete" }],
    meshSettings: { preset: "medium", status: "complete" },
    solverSettings: { backend: "opencae_core_local" },
    validation: [],
    runs: [],
    ...overrides
  } as Study;
}

function cantileverDisplayModel(): DisplayModel {
  return {
    id: "display-cantilever",
    name: "cantilever demo body",
    bodyCount: 1,
    dimensions: { x: 180, y: 24, z: 24, units: "mm" },
    faces: [
      { id: "face-base-left", label: "Fixed end face", color: "#4da3ff", center: [-1.9, 0.18, 0], normal: [-1, 0, 0], stressValue: 132 },
      { id: "face-load-top", label: "Free end load face", color: "#f59e0b", center: [1.9, 0.18, 0], normal: [1, 0, 0], stressValue: 96 },
      { id: "face-beam-top", label: "Top beam face", color: "#22c55e", center: [0, 0.42, 0], normal: [0, 1, 0], stressValue: 74 },
      { id: "face-base-bottom", label: "Beam bottom face", color: "#8b949e", center: [0, -0.08, 0], normal: [0, -1, 0], stressValue: 46 }
    ]
  };
}

function bracketDisplayModelFixture(): DisplayModel {
  return {
    id: "display-bracket",
    name: "bracket demo body",
    bodyCount: 1,
    dimensions: { x: 120, y: 88, z: 34, units: "mm" },
    faces: [
      { id: "face-base-left", label: "Base mounting holes", color: "#4da3ff", center: [0.65, 0.02, 0.58], normal: [0, 0, 1], stressValue: 36 },
      { id: "face-load-top", label: "Top load face", color: "#f59e0b", center: [-1.18, 2.53, 0], normal: [0, 1, 0], stressValue: 142 },
      { id: "face-web-front", label: "Gusset face", color: "#22c55e", center: [-0.38, 0.86, 0.42], normal: [0, 0, 1], stressValue: 96 }
    ]
  };
}

describe("bracket mesh preset sizing", () => {
  test("maps each mesh preset to a distinct gmsh characteristic size", () => {
    expect(bracketMeshSizeMmForPreset("coarse")).toBe(18);
    expect(bracketMeshSizeMmForPreset("medium")).toBe(12);
    expect(bracketMeshSizeMmForPreset("fine")).toBe(9);
    expect(bracketMeshSizeMmForPreset("ultra")).toBe(7);
    expect(new Set([
      bracketMeshSizeMmForPreset("coarse"),
      bracketMeshSizeMmForPreset("medium"),
      bracketMeshSizeMmForPreset("fine"),
      bracketMeshSizeMmForPreset("ultra")
    ]).size).toBe(4);
  });

  test("applies the study mesh preset to the procedural bracket descriptor", () => {
    const study = studyFixture({ meshSettings: { preset: "fine", status: "complete" } });
    const geometry = cloudGeometrySourceForStudy(study, bracketDisplayModelFixture());
    expect(geometry?.kind).toBe("sample_procedural");
    expect(geometry?.sampleId).toBe("bracket");
    expect(geometry?.descriptor?.meshSize).toBe(9);
  });

  test("overrides the static meshSize on explicit bracket geometry artifacts", () => {
    const study = studyFixture({ meshSettings: { preset: "ultra", status: "complete" } });
    const displayModel = {
      ...bracketDisplayModelFixture(),
      coreCloudGeometry: {
        kind: "sample_procedural",
        sampleId: "bracket",
        units: "mm",
        descriptor: { base: { length: 120, width: 34, height: 10 }, meshSize: 18 }
      }
    } as DisplayModel;
    const geometry = cloudGeometrySourceForStudy(study, displayModel);
    expect(geometry?.descriptor?.meshSize).toBe(7);
    expect(geometry?.descriptor?.base).toEqual({ length: 120, width: 34, height: 10 });
  });

  test("leaves non-bracket geometry descriptors untouched", () => {
    const study = studyFixture({ meshSettings: { preset: "ultra", status: "complete" } });
    const geometry = cloudGeometrySourceForStudy(study, cantileverDisplayModel());
    expect(geometry?.kind).toBe("structured_block");
    expect(geometry?.descriptor?.meshSize).toBeUndefined();
  });
});

describe("display to solver frame conversion", () => {
  test("rotates sample display directions into the upright solver frame", () => {
    const displayModel = cantileverDisplayModel();
    // Viewer "-Z" (down) is stored as display -Y and must become solver -Z (down).
    expect(displayDirectionToSolverFrame([0, -1, 0], displayModel)).toEqual([0, 0, -1]);
    // Viewer "+Y" (sideways) is stored as display -Z and must become solver +Y.
    expect(displayDirectionToSolverFrame([0, 0, -1], displayModel)).toEqual([0, 1, 0]);
    expect(displayDirectionToSolverFrame([1, 0, 0], displayModel)).toEqual([1, 0, 0]);
  });

  test("keeps uploaded geometry directions in file coordinates", () => {
    const uploaded: DisplayModel = {
      ...cantileverDisplayModel(),
      id: "display-uploaded",
      visualMesh: { format: "stl", filename: "part.stl", contentBase64: "" }
    };
    expect(displayDirectionToSolverFrame([0, -1, 0], uploaded)).toEqual([0, -1, 0]);
    expect(displayDirectionToSolverFrame([0, -1, 0], undefined)).toEqual([0, -1, 0]);
  });

  test("rewrites study load directions for cloud geometry dispatch", () => {
    const study = studyFixture({
      loads: [{ id: "load-1", type: "force", selectionRef: "selection-load-face", parameters: { value: 500, units: "N", direction: [0, -1, 0] }, status: "complete" }]
    });
    const dispatched = studyForCoreCloudGeometryDispatch(study, cantileverDisplayModel());
    expect(dispatched.loads[0]?.parameters.direction).toEqual([0, 0, -1]);
    expect(dispatched.loads[0]?.parameters.value).toBe(500);
    // The original study must stay in display space for the viewer and local solves.
    expect(study.loads[0]?.parameters.direction).toEqual([0, -1, 0]);
  });
});

describe("core cloud structured block model frame", () => {
  function downLoadedStudy(): Study {
    return studyFixture({
      loads: [{ id: "load-1", type: "force", selectionRef: "selection-load-face", parameters: { value: 500, units: "N", direction: [0, -1, 0] }, status: "complete" }]
    });
  }

  test("builds the structured block mesh upright with solver-frame load vectors", () => {
    // Non-square section so a height/width axis swap cannot hide: display y (height)
    // is 24 mm and display z (width) is 36 mm.
    const displayModel: DisplayModel = {
      ...cantileverDisplayModel(),
      dimensions: { x: 180, y: 24, z: 36, units: "mm" }
    };
    const coreBuild = buildOpenCaeCoreCloudModelForStudy(downLoadedStudy(), displayModel);
    const spans = coordinateSpans(coreBuild.model.nodes.coordinates);
    expect(spans.x).toBeCloseTo(0.18, 9);
    expect(spans.y).toBeCloseTo(0.036, 9);
    expect(spans.z).toBeCloseTo(0.024, 9);
    expect(coreBuild.model.coordinateSystem?.renderCoordinateSpace).toBe("solver");
    expect(coreBuild.meshSource).toBe("structured_block_core");

    const force = coreBuild.model.loads.find((load) => load.type === "surfaceForce");
    expect(force?.type === "surfaceForce" ? force.totalForce : undefined).toEqual([0, 0, -500]);
  });

  test("solves the cantilever with the tip deflecting along the applied -Z load", () => {
    const coreBuild = buildOpenCaeCoreCloudModelForStudy(downLoadedStudy(), cantileverDisplayModel());
    const solved = solveCoreStatic(coreBuild.model, { method: "sparse", solverMode: "sparse" });
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;

    const surfaceMesh = solved.result.surfaceMesh ?? solverSurfaceMeshFromModel(coreBuild.model);
    const displacement = solved.result.fields.find((field) => field.type === "displacement" && field.surfaceMeshRef === surfaceMesh.id);
    expect(displacement?.vectors?.length).toBe(surfaceMesh.nodes.length);

    const tipX = Math.max(...surfaceMesh.nodes.map((node) => node[0]));
    let tipY = 0;
    let tipZ = 0;
    let tipCount = 0;
    surfaceMesh.nodes.forEach((node, index) => {
      if (Math.abs(node[0] - tipX) > 1e-9) return;
      const vector = displacement?.vectors?.[index] ?? [0, 0, 0];
      tipY += vector[1];
      tipZ += vector[2];
      tipCount += 1;
    });
    expect(tipCount).toBeGreaterThan(0);
    const meanTipZ = tipZ / tipCount;
    const meanTipY = tipY / tipCount;
    // The free end must deflect downward (solver -Z), matching the viewer load arrow,
    // and must not bend sideways across the beam width.
    expect(meanTipZ).toBeLessThan(0);
    expect(Math.abs(meanTipZ)).toBeGreaterThan(Math.abs(meanTipY) * 10);
  });

  test("local solver-cpu builders emit render-ready surface node fields including safety factor", () => {
    // Parity with the cloud container: the same @opencae/solver-cpu builders back both, so a
    // local solveCoreStatic result must carry the surface mesh plus node-located
    // stress/displacement/safety-factor fields aligned 1:1 with surfaceMesh.nodes — the exact
    // contract the web surface render path (solverSurfaceResultFields) consumes.
    const coreBuild = buildOpenCaeCoreCloudModelForStudy(downLoadedStudy(), cantileverDisplayModel());
    const solved = solveCoreStatic(coreBuild.model, { method: "sparse", solverMode: "sparse" });
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;

    const surfaceMesh = solved.result.surfaceMesh ?? solverSurfaceMeshFromModel(coreBuild.model);
    for (const type of ["stress", "displacement", "safety_factor"] as const) {
      const field = solved.result.fields.find((candidate) => candidate.type === type && candidate.surfaceMeshRef === surfaceMesh.id);
      expect(field, `missing surface node field for ${type}`).toBeDefined();
      expect(field?.location).toBe("node");
      expect(field?.values.length).toBe(surfaceMesh.nodes.length);
    }
    const safetyField = solved.result.fields.find((candidate) => candidate.type === "safety_factor" && candidate.surfaceMeshRef === surfaceMesh.id);
    expect(safetyField?.id).toBe("safety-factor-surface");
    expect(safetyField?.units).toBe("ratio");
  });
});

function coordinateSpans(coordinates: number[]): { x: number; y: number; z: number } {
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let index = 0; index < coordinates.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, coordinates[index + axis] ?? 0);
      max[axis] = Math.max(max[axis]!, coordinates[index + axis] ?? 0);
    }
  }
  return { x: max[0]! - min[0]!, y: max[1]! - min[1]!, z: max[2]! - min[2]! };
}

describe("local core solve mesh statistics", () => {
  test("reports the actual solver mesh node and element counts as artifacts", () => {
    const solved = trySolveOpenCaeCoreStudy({
      study: studyFixture(),
      runId: "run-test",
      displayModel: cantileverDisplayModel()
    });
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    const stats = solved.result.artifacts?.meshStatistics;
    expect(stats).toBeDefined();
    expect(stats!.nodes).toBeGreaterThan(0);
    expect(stats!.elements).toBeGreaterThan(0);
    // Medium preset structured block proxy for this 180x24x24 mm cantilever:
    // 3 cells across the 24 mm minimum dimension (distinct coarse/medium/fine/ultra
    // densities {2,3,4,5}) gives a 23x3x3 grid elevated from Tet4 to Tet10 with
    // shared midside nodes: (2*23+1)*(2*3+1)*(2*3+1) = 2303 nodes.
    expect(stats!.nodes).toBe(2303);
    expect(stats!.elements).toBe(23 * 3 * 3 * 6);
  });
});
