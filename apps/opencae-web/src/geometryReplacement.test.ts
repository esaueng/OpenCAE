import { describe, expect, test } from "vitest";
import type { Study } from "@opencae/schema";
import { formatGeometryReplacementLosses, geometryReplacementLosses } from "./geometryReplacement";

const study: Study = {
  id: "study-1",
  projectId: "project-1",
  name: "Static Stress",
  type: "static_stress",
  geometryScope: [],
  materialAssignments: [{ id: "assign", materialId: "mat-aluminum-6061", selectionRef: "body", status: "complete" }],
  namedSelections: [],
  contacts: [],
  constraints: [
    { id: "fs-1", type: "fixed", selectionRef: "face-a", parameters: {}, status: "complete" },
    { id: "fs-2", type: "fixed", selectionRef: "face-b", parameters: {}, status: "complete" }
  ],
  loads: [{ id: "l-1", type: "force", selectionRef: "face-c", parameters: { value: 500, direction: [0, 0, -1] }, status: "complete" }],
  meshSettings: { preset: "medium", status: "complete", summary: { nodes: 10, elements: 4, warnings: [] } },
  solverSettings: {},
  validation: [],
  runs: []
};

describe("geometryReplacementLosses", () => {
  test("names everything a replacement would clear", () => {
    expect(geometryReplacementLosses(study, true)).toEqual([
      "1 material assignment", "2 supports", "1 load", "the generated mesh", "the current results"
    ]);
    expect(formatGeometryReplacementLosses(geometryReplacementLosses(study, true))).toBe(
      "1 material assignment, 2 supports, 1 load, the generated mesh and the current results"
    );
  });

  test("is empty for a blank study, so no dialog interrupts a first upload", () => {
    expect(geometryReplacementLosses({ ...study, materialAssignments: [], constraints: [], loads: [], meshSettings: { preset: "medium", status: "not_started" } }, false)).toEqual([]);
    expect(geometryReplacementLosses(null, false)).toEqual([]);
  });

  test("uses thermal vocabulary for temperature boundaries", () => {
    expect(geometryReplacementLosses({ ...study, type: "steady_state_thermal", loads: [], materialAssignments: [], meshSettings: { preset: "medium", status: "not_started" } } as Study, false)).toEqual(["2 temperature boundaries"]);
  });
});
