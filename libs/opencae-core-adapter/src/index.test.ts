import { describe, expect, test } from "vitest";
import type { DisplayModel, Study } from "@opencae/schema";
import {
  bracketMeshSizeMmForPreset,
  cloudGeometrySourceForStudy,
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
    // Medium preset structured block proxy: (4+1)*(3+1)*(3+1) nodes, 6 tets per cell.
    expect(stats!.nodes).toBe(80);
    expect(stats!.elements).toBe(4 * 3 * 3 * 6);
  });
});
