import { describe, expect, test } from "vitest";
import { createSampleProject, sampleDisplayModelFor } from "./projectFactory";

describe("projectFactory", () => {
  test("creates a usable project from each selectable sample", () => {
    for (const sampleId of ["bracket", "plate", "cantilever"] as const) {
      const project = createSampleProject(sampleId, {
        projectId: `project-${sampleId}`,
        studyId: `study-${sampleId}`,
        name: `Test ${sampleId}`,
        now: "2026-04-24T12:00:00.000Z",
        includeSeedRun: false
      });

      expect(project.name).toBe(`Test ${sampleId}`);
      expect(project.studies).toHaveLength(1);
      expect(project.studies[0]?.projectId).toBe(project.id);
      expect(project.geometryFiles[0]?.filename).toContain(sampleId);
      expect(sampleDisplayModelFor(sampleId).name.toLowerCase()).toContain(sampleId);
    }
  });
});
