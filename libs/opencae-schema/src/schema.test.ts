import { describe, expect, it } from "vitest";
import { ProjectSchema } from "./index";

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
});
