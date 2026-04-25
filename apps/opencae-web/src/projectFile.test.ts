import { describe, expect, test } from "vitest";
import type { DisplayModel, Project, ResultField, ResultSummary } from "@opencae/schema";
import { buildLocalProjectFile, suggestedProjectFilename } from "./projectFile";

const project = {
  id: "project-1",
  name: "Bracket Demo",
  schemaVersion: "0.1.0",
  unitSystem: "SI",
  geometryFiles: [],
  studies: [],
  createdAt: "2026-04-24T12:00:00.000Z",
  updatedAt: "2026-04-24T12:00:00.000Z"
} satisfies Project;

const displayModel = {
  id: "display-1",
  name: "Display",
  bodyCount: 0,
  faces: []
} satisfies DisplayModel;

describe("projectFile", () => {
  test("builds a reopenable local project payload", () => {
    const payload = buildLocalProjectFile(project, displayModel, "2026-04-24T13:00:00.000Z");

    expect(payload.format).toBe("opencae-local-project");
    expect(payload.version).toBe(2);
    expect(payload.project.updatedAt).toBe("2026-04-24T13:00:00.000Z");
    expect(payload.displayModel).toBe(displayModel);
  });

  test("keeps saved model orientation in the local project payload", () => {
    const orientedDisplayModel = { ...displayModel, orientation: { x: 0, y: 90, z: 180 } } satisfies DisplayModel;
    const payload = buildLocalProjectFile(project, orientedDisplayModel, "2026-04-24T13:00:00.000Z");

    expect(payload.displayModel.orientation).toEqual({ x: 0, y: 90, z: 180 });
  });

  test("can include simulation results in the local project payload", () => {
    const summary = {
      maxStress: 168.5,
      maxStressUnits: "MPa",
      maxDisplacement: 0.157,
      maxDisplacementUnits: "mm",
      safetyFactor: 1.64,
      reactionForce: 500,
      reactionForceUnits: "N"
    } satisfies ResultSummary;
    const fields = [{
      id: "field-1",
      runId: "run-1",
      type: "stress",
      location: "face",
      values: [12, 24],
      min: 12,
      max: 24,
      units: "MPa"
    }] satisfies ResultField[];

    const payload = buildLocalProjectFile(project, displayModel, "2026-04-24T13:00:00.000Z", {
      activeRunId: "run-1",
      completedRunId: "run-1",
      summary,
      fields
    });

    expect(payload.results?.summary).toBe(summary);
    expect(payload.results?.fields).toBe(fields);
    expect(payload.results?.completedRunId).toBe("run-1");
  });

  test("suggests a safe local filename", () => {
    expect(suggestedProjectFilename("Bracket Demo")).toBe("bracket-demo.opencae.json");
    expect(suggestedProjectFilename("  ")).toBe("opencae-project.opencae.json");
  });
});
