import { describe, expect, it } from "vitest";
import type { Study } from "@opencae/schema";
import { inferCriticalPrintAxis, validateStaticStressStudy, validateStudy } from "./index";

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

  it("infers the dominant bending span as the critical print axis", () => {
    const study: Study = {
      ...readyStudy,
      constraints: [{ id: "fixed", type: "fixed", selectionRef: "selection-fixed-face", parameters: {}, status: "complete" }],
      namedSelections: [
        {
          id: "selection-fixed-face",
          name: "Fixed end face",
          entityType: "face",
          geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-base-left", label: "Fixed end face" }],
          fingerprint: "fixed"
        },
        {
          id: "selection-load-face",
          name: "Free end load face",
          entityType: "face",
          geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-load-top", label: "Free end load face" }],
          fingerprint: "load"
        }
      ],
      loads: [{
        id: "load-free-end",
        type: "force",
        selectionRef: "selection-load-face",
        parameters: { value: 500, direction: [0, 0, -1] },
        status: "complete"
      }]
    };

    expect(inferCriticalPrintAxis(study, [
      { selectionId: "selection-fixed-face", entityId: "face-base-left", center: [-1.8, 0.18, 0] },
      { selectionId: "selection-load-face", entityId: "face-load-top", center: [1.75, 0.18, 0] }
    ])).toBe("x");
  });

  it("preserves static validation through the generic validator", () => {
    expect(validateStudy(readyStudy)).toEqual([]);
  });

  it("validates dynamic structural time settings and required setup", () => {
    const dynamicStudy: Study = {
      ...readyStudy,
      name: "Dynamic",
      type: "dynamic_structural",
      materialAssignments: [],
      constraints: [],
      loads: [],
      meshSettings: { preset: "medium", status: "not_started" },
      solverSettings: {
        startTime: 0.1,
        endTime: 0.1,
        timeStep: 0,
        outputInterval: 0,
        dampingRatio: -0.1,
        integrationMethod: "newmark_average_acceleration"
      }
    };

    expect(validateStudy(dynamicStudy).map((item) => item.message)).toEqual([
      "Choose what the part is made of.",
      "Choose where force, pressure, or payload weight is applied.",
      "Generate the mesh before running.",
      "Add at least one support or enable free motion for the dynamic run.",
      "Dynamic end time must be greater than start time.",
      "Dynamic time step must be greater than zero.",
      "Dynamic output interval must be greater than zero and no smaller than the time step.",
      "Dynamic damping ratio cannot be negative."
    ]);
  });

  it("allows support-free dynamic runs only when free motion is explicitly enabled", () => {
    const dynamicStudy: Study = {
      ...readyStudy,
      name: "Dynamic",
      type: "dynamic_structural",
      constraints: [],
      solverSettings: {
        startTime: 0,
        endTime: 0.1,
        timeStep: 0.005,
        outputInterval: 0.005,
        dampingRatio: 0.02,
        integrationMethod: "newmark_average_acceleration",
        allowFreeMotion: true
      }
    };

    expect(validateStudy(dynamicStudy)).toEqual([]);
  });
});
