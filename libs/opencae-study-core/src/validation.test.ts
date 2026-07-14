import { describe, expect, it } from "vitest";
import type { DisplayModel, Study } from "@opencae/schema";
import { globalBuildAxisToModelAxis, inferCriticalPrintAxis, modelAxisToGlobalBuildAxis, validateStaticStressStudy, validateStudy } from "./index";

describe("validateStaticStressStudy", () => {
  const readyStudy: Study = {
    id: "study-test",
    projectId: "project-test",
    name: "Static Stress",
    type: "static_stress",
    geometryScope: [],
    materialAssignments: [{ id: "assign", materialId: "mat-aluminum-6061", selectionRef: "body", status: "complete" }],
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

  it("rejects a zero-length load direction", () => {
    const study = {
      ...readyStudy,
      loads: [{ ...readyStudy.loads[0]!, parameters: { value: 500, direction: [0, 0, 0] } }]
    };

    expect(validateStaticStressStudy(study).map((item) => item.message)).toEqual([
      "Load force needs a 3D direction vector."
    ]);
    expect(inferCriticalPrintAxis(study, [{ selectionId: "face", entityId: "face-1", center: [1, 0, 0] }])).toBeUndefined();
  });

  it("retains the dominant bending span when the cantilever clamp normal follows the span", () => {
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

  it("removes the force-parallel span before choosing the bracket bending axis", () => {
    const bracketStudy: Study = {
      ...readyStudy,
      constraints: [{ id: "fixed", type: "fixed", selectionRef: "selection-fixed-face", parameters: {}, status: "complete" }],
      namedSelections: [
        {
          id: "selection-fixed-face",
          name: "Fixed base face",
          entityType: "face",
          geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-base", label: "Fixed base face" }],
          fingerprint: "fixed"
        },
        {
          id: "selection-load-face",
          name: "Top load face",
          entityType: "face",
          geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-load", label: "Top load face" }],
          fingerprint: "load"
        }
      ],
      loads: [{
        id: "load-downward",
        type: "force",
        selectionRef: "selection-load-face",
        // Stored sample-model -Y renders and solves as user-facing global -Z.
        parameters: { value: 500, direction: [0, -1, 0] },
        status: "complete"
      }]
    };
    const faces = [
      { selectionId: "selection-fixed-face", entityId: "face-base", center: [0.65, 0.02, 0.58] },
      { selectionId: "selection-load-face", entityId: "face-load", center: [-1.18, 2.53, 0] }
    ] satisfies Parameters<typeof inferCriticalPrintAxis>[1];

    expect(inferCriticalPrintAxis(bracketStudy, faces)).toBe("x");
    expect(inferCriticalPrintAxis({
      ...bracketStudy,
      loads: [{ ...bracketStudy.loads[0]!, parameters: { value: 500, direction: [0, 1, 0] } }]
    }, faces)).toBe("x");
  });

  it("uses the span axis for axial loads regardless of force sign", () => {
    const axialStudy: Study = {
      ...readyStudy,
      constraints: [{ id: "fixed", type: "fixed", selectionRef: "selection-fixed-face", parameters: {}, status: "complete" }],
      namedSelections: [
        {
          id: "selection-fixed-face",
          name: "Fixed end face",
          entityType: "face",
          geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-fixed", label: "Fixed end face" }],
          fingerprint: "fixed"
        },
        {
          id: "selection-load-face",
          name: "Axial load face",
          entityType: "face",
          geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-load", label: "Axial load face" }],
          fingerprint: "load"
        }
      ],
      loads: [{
        id: "load-axial",
        type: "force",
        selectionRef: "selection-load-face",
        parameters: { value: 500, direction: [0, -1, 0] },
        status: "complete"
      }]
    };
    const faces = [
      { selectionId: "selection-fixed-face", entityId: "face-fixed", center: [0, 0, 0] },
      { selectionId: "selection-load-face", entityId: "face-load", center: [0, 3, 0] }
    ] satisfies Parameters<typeof inferCriticalPrintAxis>[1];

    expect(inferCriticalPrintAxis(axialStudy, faces)).toBe("y");
    expect(inferCriticalPrintAxis({
      ...axialStudy,
      loads: [{ ...axialStudy.loads[0]!, parameters: { value: 500, direction: [0, 1, 0] } }]
    }, faces)).toBe("y");
  });

  it("uses force magnitude when competing load paths govern different axes", () => {
    const competingStudy: Study = {
      ...readyStudy,
      constraints: [{ id: "fixed", type: "fixed", selectionRef: "selection-fixed", parameters: {}, status: "complete" }],
      namedSelections: [
        {
          id: "selection-fixed",
          name: "Fixed face",
          entityType: "face",
          geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-fixed", label: "Fixed face" }],
          fingerprint: "fixed"
        },
        {
          id: "selection-x",
          name: "X load face",
          entityType: "face",
          geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-x", label: "X load face" }],
          fingerprint: "x"
        },
        {
          id: "selection-y",
          name: "Y load face",
          entityType: "face",
          geometryRefs: [{ bodyId: "body", entityType: "face", entityId: "face-y", label: "Y load face" }],
          fingerprint: "y"
        }
      ],
      loads: [
        { id: "load-x", type: "force", selectionRef: "selection-x", parameters: { value: 10, direction: [0, 0, -1] }, status: "complete" },
        { id: "load-y", type: "force", selectionRef: "selection-y", parameters: { value: 100, direction: [0, 0, -1] }, status: "complete" }
      ]
    };
    const faces = [
      { selectionId: "selection-fixed", entityId: "face-fixed", center: [0, 0, 0] },
      { selectionId: "selection-x", entityId: "face-x", center: [4, 0, 0] },
      { selectionId: "selection-y", entityId: "face-y", center: [0, 2, 0] }
    ] satisfies Parameters<typeof inferCriticalPrintAxis>[1];

    expect(inferCriticalPrintAxis(competingStudy, faces)).toBe("y");
    expect(inferCriticalPrintAxis({
      ...competingStudy,
      loads: [
        { ...competingStudy.loads[0]!, parameters: { value: 100, direction: [0, 0, -1] } },
        { ...competingStudy.loads[1]!, parameters: { value: 10, direction: [0, 0, -1] } }
      ]
    }, faces)).toBe("x");

    expect(inferCriticalPrintAxis({
      ...competingStudy,
      loads: [
        { ...competingStudy.loads[0]!, parameters: { value: 100, units: "N", direction: [0, 0, -1] } },
        { ...competingStudy.loads[1]!, type: "gravity", parameters: { value: 30, units: "kg", direction: [0, 0, -1] } }
      ]
    }, faces)).toBe("y");

    const facesWithPressureArea = faces.map((face) => face.selectionId === "selection-y" ? { ...face, areaM2: 0.01 } : face);
    expect(inferCriticalPrintAxis({
      ...competingStudy,
      loads: [
        { ...competingStudy.loads[0]!, parameters: { value: 100, units: "N", direction: [0, 0, -1] } },
        { ...competingStudy.loads[1]!, type: "pressure", parameters: { value: 30, units: "kPa", direction: [0, 0, -1] } }
      ]
    }, facesWithPressureArea)).toBe("y");
    expect(inferCriticalPrintAxis({
      ...competingStudy,
      loads: [
        { ...competingStudy.loads[0]!, parameters: { value: 100, units: "N", direction: [0, 0, -1] } },
        { ...competingStudy.loads[1]!, type: "pressure", parameters: { value: 30, units: "kPa", direction: [0, 0, -1] } }
      ]
    }, faces)).toBeUndefined();
  });

  it("round-trips model and global build axes for sample and uploaded frames", () => {
    const sample = { id: "sample-bracket", bodyCount: 1, faces: [], orientation: { x: 0, y: 0, z: 0 } } as DisplayModel;
    expect(modelAxisToGlobalBuildAxis("x", sample)).toBe("x");
    expect(modelAxisToGlobalBuildAxis("y", sample)).toBe("z");
    expect(modelAxisToGlobalBuildAxis("z", sample)).toBe("y");

    const rotatedSample = { ...sample, orientation: { x: 0, y: 0, z: 90 } };
    expect(modelAxisToGlobalBuildAxis("x", rotatedSample)).toBe("y");
    expect(globalBuildAxisToModelAxis("y", rotatedSample)).toBe("x");

    const uploaded = { ...sample, id: "uploaded-step" };
    expect(modelAxisToGlobalBuildAxis("y", uploaded)).toBe("y");
    const rotatedUpload = { ...uploaded, orientation: { x: 0, y: 0, z: 90 } };
    expect(modelAxisToGlobalBuildAxis("x", rotatedUpload)).toBe("y");
    expect(globalBuildAxisToModelAxis("y", rotatedUpload)).toBe("x");
  });

  it("preserves static validation through the generic validator", () => {
    expect(validateStudy(readyStudy)).toEqual([]);
  });

  it("resolves project custom materials and reports dangling material IDs clearly", () => {
    const custom = {
      id: "0ac4dbda-1d37-43c0-b3ac-9d1d2cc28e84",
      name: "Shop aluminum",
      category: "metal" as const,
      youngsModulus: 70e9,
      poissonRatio: 0.33,
      density: 2710,
      yieldStrength: 290e6,
      verification: "user_supplied_unverified" as const
    };
    const customStudy = {
      ...readyStudy,
      materialAssignments: [{ ...readyStudy.materialAssignments[0]!, materialId: custom.id }]
    };
    const unknownStudy = {
      ...readyStudy,
      materialAssignments: [{ ...readyStudy.materialAssignments[0]!, materialId: "deleted-custom-material" }]
    };

    expect(validateStudy(customStudy, [custom])).toEqual([]);
    expect(validateStudy(unknownStudy).map((diagnostic) => diagnostic.message)).toContain('Unknown material "deleted-custom-material".');
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

  it("rejects dynamic time settings that request an excessive number of integration steps", () => {
    const dynamicStudy: Study = {
      ...readyStudy,
      name: "Dynamic",
      type: "dynamic_structural",
      solverSettings: {
        startTime: 0,
        endTime: 1_000_000_000,
        timeStep: 0.005,
        outputInterval: 0.005,
        dampingRatio: 0.02,
        integrationMethod: "newmark_average_acceleration"
      }
    };

    expect(validateStudy(dynamicStudy).map((item) => item.message)).toEqual([
      "Dynamic run would need more than 2,000,000 integration steps. Increase the time step or shorten the time range."
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
