import { describe, expect, it } from "vitest";
import { ProjectSchema, ResultFieldSchema, RunEventSchema } from "./index";

describe("ProjectSchema", () => {
  it("accepts the minimum local project shape", () => {
    const parsed = ProjectSchema.parse({
      id: "project-test",
      name: "Test Project",
      schemaVersion: "0.1.0",
      unitSystem: "SI",
      geometryFiles: [],
      studies: [],
      createdAt: "2026-04-24T12:00:00.000Z",
      updatedAt: "2026-04-24T12:00:00.000Z"
    });

    expect(parsed.name).toBe("Test Project");
  });

  it("preserves 3D print parameters on material assignments", () => {
    const parsed = ProjectSchema.parse({
      id: "project-test",
      name: "Test Project",
      schemaVersion: "0.1.0",
      unitSystem: "SI",
      geometryFiles: [],
      studies: [
        {
          id: "study-test",
          projectId: "project-test",
          name: "Static Stress",
          type: "static_stress",
          geometryScope: [],
          materialAssignments: [
            {
              id: "assign-material",
              materialId: "mat-petg",
              selectionRef: "selection-body",
              parameters: {
                printed: true,
                infillDensity: 35,
                wallCount: 3,
                layerOrientation: "z"
              },
              status: "complete"
            }
          ],
          namedSelections: [],
          contacts: [],
          constraints: [],
          loads: [],
          meshSettings: { preset: "medium", status: "not_started" },
          solverSettings: {},
          validation: [],
          runs: []
        }
      ],
      createdAt: "2026-04-24T12:00:00.000Z",
      updatedAt: "2026-04-24T12:00:00.000Z"
    });

    expect(parsed.studies[0]?.materialAssignments[0]?.parameters).toMatchObject({
      printed: true,
      infillDensity: 35
    });
  });

  it("accepts dynamic structural studies and applies default solver settings", () => {
    const parsed = ProjectSchema.parse({
      id: "project-test",
      name: "Dynamic Project",
      schemaVersion: "0.1.0",
      unitSystem: "SI",
      geometryFiles: [],
      studies: [
        {
          id: "study-dynamic",
          projectId: "project-test",
          name: "Dynamic",
          type: "dynamic_structural",
          geometryScope: [],
          materialAssignments: [],
          namedSelections: [],
          contacts: [],
          constraints: [],
          loads: [],
          meshSettings: { preset: "medium", status: "not_started" },
          solverSettings: {},
          validation: [],
          runs: []
        }
      ],
      createdAt: "2026-04-24T12:00:00.000Z",
      updatedAt: "2026-04-24T12:00:00.000Z"
    });

    expect(parsed.studies[0]?.type).toBe("dynamic_structural");
    expect(parsed.studies[0]?.solverSettings).toMatchObject({
      startTime: 0,
      endTime: 0.1,
      timeStep: 0.005,
      outputInterval: 0.005,
      dampingRatio: 0.02,
      integrationMethod: "newmark_average_acceleration"
    });
  });

  it("accepts framed velocity and acceleration result fields while keeping unframed static fields valid", () => {
    expect(ResultFieldSchema.parse({
      id: "field-velocity-frame-1",
      runId: "run-dynamic",
      type: "velocity",
      location: "face",
      values: [0, 1.25],
      min: 0,
      max: 1.25,
      units: "mm/s",
      frameIndex: 1,
      timeSeconds: 0.005
    })).toMatchObject({ frameIndex: 1, timeSeconds: 0.005 });

    expect(ResultFieldSchema.parse({
      id: "field-stress-static",
      runId: "run-static",
      type: "stress",
      location: "face",
      values: [42],
      min: 42,
      max: 42,
      units: "MPa"
    }).frameIndex).toBeUndefined();
  });

  it("accepts optional timing estimates on run events", () => {
    const parsed = RunEventSchema.parse({
      runId: "run-dynamic",
      type: "progress",
      progress: 62,
      message: "Integrating dynamic response.",
      timestamp: "2026-04-24T12:00:00.000Z",
      elapsedMs: 1200,
      estimatedDurationMs: 4800,
      estimatedRemainingMs: 3600
    });

    expect(parsed).toMatchObject({
      elapsedMs: 1200,
      estimatedDurationMs: 4800,
      estimatedRemainingMs: 3600
    });
  });

  it("accepts detailed simulation backend settings and ultra mesh quality", () => {
    const parsed = ProjectSchema.parse({
      id: "project-detailed",
      name: "Detailed Project",
      schemaVersion: "0.1.0",
      unitSystem: "SI",
      geometryFiles: [],
      studies: [
        {
          id: "study-detailed",
          projectId: "project-detailed",
          name: "Detailed Static",
          type: "static_stress",
          geometryScope: [],
          materialAssignments: [],
          namedSelections: [],
          contacts: [],
          constraints: [],
          loads: [],
          meshSettings: { preset: "ultra", status: "complete", summary: { nodes: 182400, elements: 119808, warnings: [], analysisSampleCount: 45000, quality: "ultra" } },
          solverSettings: { backend: "cloudflare_fea", fidelity: "ultra" },
          validation: [],
          runs: []
        }
      ],
      createdAt: "2026-04-24T12:00:00.000Z",
      updatedAt: "2026-04-24T12:00:00.000Z"
    });

    expect(parsed.studies[0]?.meshSettings.preset).toBe("ultra");
    expect(parsed.studies[0]?.solverSettings).toMatchObject({
      backend: "cloudflare_fea",
      fidelity: "ultra"
    });
  });

  it("accepts rich result sample metadata from local and cloud FEA backends", () => {
    const parsed = ResultFieldSchema.parse({
      id: "field-stress-cloud",
      runId: "run-cloud",
      type: "stress",
      location: "node",
      values: [123100],
      min: 123100,
      max: 123100,
      units: "Pa",
      samples: [
        {
          point: [0, 0, 0],
          normal: [0, 1, 0],
          value: 123100,
          nodeId: "N42",
          elementId: "E7",
          source: "calculix",
          vonMisesStressPa: 123100
        }
      ]
    });

    expect(parsed.samples?.[0]).toMatchObject({
      nodeId: "N42",
      elementId: "E7",
      source: "calculix",
      vonMisesStressPa: 123100
    });
  });
});
