import type { Project } from "@opencae/schema";

/**
 * Minimal shape of an imported result bundle whose run references must follow
 * the remapped run ids. The full bundle in the server carries more fields; they
 * pass through unchanged.
 */
export interface RemappableImportResults {
  activeRunId?: string;
  completedRunId?: string;
  fields: { runId: string }[];
}

export interface ClonedImportIdentity<R extends RemappableImportResults> {
  project: Project;
  results: R | undefined;
}

function freshId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/**
 * Returns a deep copy of an imported project under a brand-new identity so an
 * import can never overwrite or prune an existing local project that happens to
 * share an id. New ids are minted for the project and for every study, run, and
 * geometry file, and the project/study/run cross-references are rewritten to
 * match.
 *
 * Study-local references (named selections, and the loads/constraints that
 * point at them via `selectionRef`) keep their ids: they are scoped within a
 * single study, so leaving them untouched keeps each study internally
 * consistent while only the global database keys (project, study, run) change.
 *
 * When an imported result bundle is supplied, its run references are remapped
 * onto the new run ids so the restored results still bind to the cloned run.
 */
export function cloneImportedProjectIdentity<R extends RemappableImportResults>(
  project: Project,
  results?: R
): ClonedImportIdentity<R> {
  const newProjectId = freshId("project");
  const runIdMap = new Map<string, string>();

  const geometryFiles = project.geometryFiles.map((geometry) => ({
    ...geometry,
    id: freshId("geometry"),
    projectId: newProjectId
  }));

  const studies = project.studies.map((study) => {
    const newStudyId = freshId("study");
    const runs = study.runs.map((run) => {
      const newRunId = freshId("run");
      runIdMap.set(run.id, newRunId);
      return { ...run, id: newRunId, studyId: newStudyId };
    });
    return { ...study, id: newStudyId, projectId: newProjectId, runs };
  });

  const clonedProject: Project = {
    ...project,
    id: newProjectId,
    geometryFiles,
    studies
  };

  const remapRunId = (runId: string | undefined): string | undefined =>
    runId === undefined ? undefined : runIdMap.get(runId) ?? runId;

  const clonedResults = results
    ? ({
        ...results,
        activeRunId: remapRunId(results.activeRunId),
        completedRunId: remapRunId(results.completedRunId),
        fields: results.fields.map((field) => ({
          ...field,
          runId: remapRunId(field.runId) ?? field.runId
        }))
      } as R)
    : undefined;

  return { project: clonedProject, results: clonedResults };
}
