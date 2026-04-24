import { describe, expect, test } from "vitest";
import type { DisplayModel, Project } from "@opencae/schema";
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
    expect(payload.version).toBe(1);
    expect(payload.project.updatedAt).toBe("2026-04-24T13:00:00.000Z");
    expect(payload.displayModel).toBe(displayModel);
  });

  test("suggests a safe local filename", () => {
    expect(suggestedProjectFilename("Bracket Demo")).toBe("bracket-demo.opencae.json");
    expect(suggestedProjectFilename("  ")).toBe("opencae-project.opencae.json");
  });
});
