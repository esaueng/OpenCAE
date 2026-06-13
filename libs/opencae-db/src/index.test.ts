import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { Project, Study, StudyRun } from "@opencae/schema";
import { SQLiteDatabaseProvider } from ".";

const tempDirs: string[] = [];

function tempProvider(): SQLiteDatabaseProvider {
  const dir = mkdtempSync(join(tmpdir(), "opencae-db-"));
  tempDirs.push(dir);
  const provider = new SQLiteDatabaseProvider(join(dir, "opencae.test.sqlite"));
  provider.migrate();
  return provider;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SQLiteDatabaseProvider", () => {
  test("round-trips runs through upsertRun and embeds them in the parent study", () => {
    const db = tempProvider();
    db.upsertProject(projectWith([studyFor("study-a")]));
    const run = runFor("run-1", "study-a");

    db.upsertRun(run);

    expect(db.getRun("run-1")).toEqual(run);
    expect(db.getStudy("study-a")?.runs).toEqual([run]);
    expect(db.getProject("project-test")?.studies[0]?.runs).toEqual([run]);
  });

  test("prunes studies and their runs removed from an upserted project", () => {
    const db = tempProvider();
    db.upsertProject(projectWith([studyFor("study-a"), studyFor("study-b")]));
    db.upsertRun(runFor("run-b", "study-b"));

    db.upsertProject(projectWith([studyFor("study-a")]));

    expect(db.getStudy("study-a")).toBeDefined();
    expect(db.getStudy("study-b")).toBeUndefined();
    expect(db.getRun("run-b")).toBeUndefined();
  });

  test("prunes runs removed from an upserted study", () => {
    const db = tempProvider();
    db.upsertProject(projectWith([studyFor("study-a")]));
    db.upsertRun(runFor("run-1", "study-a"));
    db.upsertRun(runFor("run-2", "study-a"));

    db.upsertStudy({ ...studyFor("study-a"), runs: [runFor("run-2", "study-a")] });

    expect(db.getRun("run-1")).toBeUndefined();
    expect(db.getRun("run-2")).toEqual(runFor("run-2", "study-a"));
    expect(db.getStudy("study-a")?.runs.map((run) => run.id)).toEqual(["run-2"]);
  });
});

function projectWith(studies: Study[]): Project {
  return {
    id: "project-test",
    name: "Test Project",
    schemaVersion: "0.1.0",
    unitSystem: "SI",
    geometryFiles: [],
    studies,
    createdAt: "2026-04-24T12:00:00.000Z",
    updatedAt: "2026-04-24T12:00:00.000Z"
  };
}

function studyFor(studyId: string): Study {
  return {
    id: studyId,
    projectId: "project-test",
    name: "Static Stress",
    type: "static_stress",
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
  };
}

function runFor(runId: string, studyId: string): StudyRun {
  return {
    id: runId,
    studyId,
    status: "complete",
    jobId: `job-${runId}`,
    solverBackend: "local-heuristic-surface",
    solverVersion: "0.1.0",
    diagnostics: []
  };
}
