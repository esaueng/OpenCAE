import { describe, expect, it } from "vitest";
import type { Study } from "@opencae/schema";
import { validateStaticStressStudy } from "./index";

describe("validateStaticStressStudy", () => {
  const readyStudy: Study = {
    id: "study-test",
    projectId: "project-test",
    name: "Static Stress",
    type: "static_stress",
    geometryScope: [],
    materialAssignments: [{ id: "assign", materialId: "mat", selectionRef: "body", status: "complete" }],
    contacts: [],
    constraints: [{ id: "fixed", type: "fixed", selectionRef: "face", parameters: {}, status: "complete" }],
    namedSelections: [
      {
        id: "face",
        name: "Face",
        entityType: "face",
        geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-1", label: "Face" }],
        fingerprint: "face"
      }
    ],
    loads: [{ id: "force", type: "force", selectionRef: "face", parameters: { value: 500, direction: [0, -1, 0] }, status: "complete" }],
    meshSettings: { preset: "medium", status: "complete", summary: { nodes: 10, elements: 4, warnings: [] } },
    solverSettings: {},
    validation: [],
    runs: []
  };

  it("treats the Bracket Demo as ready", () => {
    expect(validateStaticStressStudy(readyStudy)).toEqual([]);
  });

  it("returns friendly setup messages for missing setup", () => {
    const study = {
      ...readyStudy,
      materialAssignments: [],
      constraints: [],
      loads: [],
      meshSettings: { preset: "medium" as const, status: "not_started" as const }
    };

    expect(validateStaticStressStudy(study).map((item) => item.message)).toEqual([
      "Choose what the part is made of.",
      "Choose where the part is held fixed.",
      "Choose where force, pressure, or payload weight is applied.",
      "Generate the mesh before running."
    ]);
  });

  it("validates every load definition", () => {
    const study = {
      ...readyStudy,
      loads: [
        { id: "bad-value", type: "force" as const, selectionRef: "face", parameters: { value: -1, direction: [0, -1, 0] }, status: "complete" as const },
        { id: "bad-direction", type: "pressure" as const, selectionRef: "face", parameters: { value: 10, direction: [0, 1] }, status: "complete" as const },
        { id: "bad-selection", type: "gravity" as const, selectionRef: "missing", parameters: { value: 9.81, direction: [0, -1, 0] }, status: "complete" as const }
      ]
    };

    expect(validateStaticStressStudy(study).map((item) => item.message)).toEqual([
      "Load bad-value needs a positive finite magnitude.",
      "Load bad-direction needs a 3D direction vector.",
      "Load bad-selection must reference a face selection."
    ]);
  });
});
