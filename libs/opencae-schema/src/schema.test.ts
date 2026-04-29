import { describe, expect, it } from "vitest";
import { ProjectSchema, ResultFieldSchema } from "./index";

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
});
