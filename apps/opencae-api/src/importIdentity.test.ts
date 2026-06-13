import { describe, expect, it } from "vitest";
import type { Project } from "@opencae/schema";
import { cloneImportedProjectIdentity, type RemappableImportResults } from "./importIdentity";

function sampleProject(): Project {
  return {
    id: "project-original",
    name: "Bracket",
    schemaVersion: "2",
    unitSystem: "SI",
    geometryFiles: [
      {
        id: "geom-original",
        projectId: "project-original",
        filename: "bracket.step",
        localPath: "/tmp/bracket.step",
        artifactKey: "project-original/geometry/bracket.json",
        status: "ready",
        metadata: {}
      }
    ],
    studies: [
      {
        id: "study-original",
        projectId: "project-original",
        name: "Static",
        type: "static_stress",
        geometryScope: [],
        materialAssignments: [],
        namedSelections: [{ id: "selection-keep", name: "Fixed face", entityRefs: [], selectionRef: "selection-keep" } as never],
        contacts: [],
        constraints: [{ id: "fix-1", type: "fixed", selectionRef: "selection-keep" } as never],
        loads: [],
        meshSettings: { preset: "medium", status: "complete" },
        validation: [],
        solverSettings: {},
        runs: [
          {
            id: "run-original",
            studyId: "study-original",
            status: "complete_local_fea",
            jobId: "job-1",
            solverBackend: "opencae_core_local",
            solverVersion: "0.1.0",
            diagnostics: []
          }
        ]
      } as never
    ],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  } as Project;
}

describe("cloneImportedProjectIdentity", () => {
  it("mints a fresh project/study/run/geometry identity and rewrites cross-references", () => {
    const original = sampleProject();
    const { project } = cloneImportedProjectIdentity(original);

    // Brand-new global ids.
    expect(project.id).not.toBe("project-original");
    expect(project.id.startsWith("project-")).toBe(true);

    const geometry = project.geometryFiles[0]!;
    expect(geometry.id).not.toBe("geom-original");
    expect(geometry.projectId).toBe(project.id);

    const study = project.studies[0]!;
    expect(study.id).not.toBe("study-original");
    expect(study.projectId).toBe(project.id);

    const run = study.runs[0]!;
    expect(run.id).not.toBe("run-original");
    expect(run.studyId).toBe(study.id);

    // Study-local selection ids are preserved so loads/constraints stay valid.
    expect(study.namedSelections[0]!.id).toBe("selection-keep");
    expect((study.constraints[0] as { selectionRef: string }).selectionRef).toBe("selection-keep");
  });

  it("does not mutate the original project", () => {
    const original = sampleProject();
    const snapshot = JSON.parse(JSON.stringify(original));
    cloneImportedProjectIdentity(original);
    expect(original).toEqual(snapshot);
  });

  it("remaps result-bundle run references onto the cloned run id", () => {
    const original = sampleProject();
    const results: RemappableImportResults & { summary: string } = {
      activeRunId: "run-original",
      completedRunId: "run-original",
      fields: [{ runId: "run-original" }, { runId: "run-original" }],
      summary: "kept"
    };

    const cloned = cloneImportedProjectIdentity(original, results);
    const newRunId = cloned.project.studies[0]!.runs[0]!.id;

    expect(cloned.results?.activeRunId).toBe(newRunId);
    expect(cloned.results?.completedRunId).toBe(newRunId);
    expect(cloned.results?.fields.every((field) => field.runId === newRunId)).toBe(true);
    // Unrelated bundle fields pass through unchanged.
    expect((cloned.results as { summary: string }).summary).toBe("kept");
  });

  it("produces ids that cannot collide with the imported file ids", () => {
    const original = sampleProject();
    const a = cloneImportedProjectIdentity(original);
    const b = cloneImportedProjectIdentity(original);
    // Two imports of the same file get distinct identities.
    expect(a.project.id).not.toBe(b.project.id);
    expect(a.project.studies[0]!.id).not.toBe(b.project.studies[0]!.id);
    expect(a.project.studies[0]!.runs[0]!.id).not.toBe(b.project.studies[0]!.runs[0]!.id);
  });
});
