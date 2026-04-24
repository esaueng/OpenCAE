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
      expect(project.studies[0]?.geometryScope[0]?.label.toLowerCase()).toContain(sampleId === "bracket" ? "bracket" : sampleId);
    }
  });

  test("returns distinct display geometry for each sample", () => {
    const bracket = sampleDisplayModelFor("bracket");
    const plate = sampleDisplayModelFor("plate");
    const cantilever = sampleDisplayModelFor("cantilever");

    expect(plate.faces).not.toEqual(bracket.faces);
    expect(cantilever.faces).not.toEqual(bracket.faces);
    expect(new Set(plate.faces.map((face) => face.id))).toEqual(new Set(bracket.faces.map((face) => face.id)));
    expect(new Set(cantilever.faces.map((face) => face.id))).toEqual(new Set(bracket.faces.map((face) => face.id)));
    expect(plate.faces.find((face) => face.id === "face-load-top")?.label).toBe("Right load pad");
    expect(cantilever.faces.find((face) => face.id === "face-base-left")?.normal).toEqual([-1, 0, 0]);
  });
});
