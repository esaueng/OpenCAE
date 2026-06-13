# Plan 002: Make Project Import Collision-Safe

Base commit: `3a67db9`
Status: TODO
Priority: 2
Category: correctness / data integrity

## Problem

The import/open route accepts ids from a saved project file and writes them with `db.upsertProject(...)`. If the imported file has the same `project.id` as a project already in the local database, the existing project is overwritten. Because `SQLiteDatabaseProvider.upsertProject` also prunes removed studies for that project id, an imported older copy can delete newer local studies/runs.

This is plausible because OpenCAE's local project file preserves the project object and ids by design.

## Current Evidence

`apps/opencae-web/src/projectFile.ts`:

```ts
return {
  format: "opencae-local-project",
  version: 2,
  savedAt,
  project: { ...projectWithEmbeddedModel, updatedAt: savedAt },
  displayModel,
  ...(results ? { results } : {})
};
```

`apps/opencae-api/src/server.ts`:

```ts
const project = withCanonicalArtifactRefs(parsed.data);
...
const importedProject = results ? projectWithImportedResultRefs(project, results) : project;
db.upsertProject(importedProject);
```

`libs/opencae-db/src/index.ts`:

```ts
this.persistProjectOnly(project);
for (const study of project.studies) {
  this.persistStudyOnly(study);
}
this.pruneRemovedStudies(project);
```

`persistProjectOnly` uses `on conflict(id) do update`, and `pruneRemovedStudies` deletes studies for the same project id that are not present in the imported project.

## Desired Behavior

Opening/importing a saved file should never overwrite an existing local project unless the user explicitly chooses an overwrite path.

Default import behavior should clone into a new project identity:

- New project id.
- New study ids.
- New run ids when imported results exist.
- Rewritten `projectId`, `studyId`, `runId`, `resultRef`, `reportRef`, geometry ids, and artifact keys.
- Original ids kept in metadata for traceability only.

## Implementation Steps

1. Add an import remapping helper in `apps/opencae-api/src/server.ts` or a new local module near the import helpers.
   - Suggested name: `cloneImportedProjectIdentity(project, results?)`.
   - Generate a new `project-${crypto.randomUUID()}` id.
   - Generate new ids for each study, run, geometry file, named selection only if references require it. Prefer remapping only ids that are global database keys: project, study, run, geometry.
   - Preserve selection ids unless changing them is necessary; loads and constraints reference selection ids within the same study.

2. Rewrite cross references.
   - `Project.geometryFiles[*].projectId`
   - `Project.studies[*].projectId`
   - `Study.runs[*].studyId`
   - `ResultField.runId`
   - `LocalResultBundle.activeRunId`
   - `LocalResultBundle.completedRunId`
   - Any `StudyRun.resultRef` and `StudyRun.reportRef`
   - Geometry artifact keys and metadata refs handled by `withCanonicalArtifactRefs(...)`.

3. Add explicit overwrite mode only if the UI needs it.
   - Default route should clone-on-import.
   - If adding overwrite support, require a request field such as `{ importMode: "overwrite" }`.
   - Reject overwrite unless `db.getProject(project.id)` exists and the caller names that mode.
   - Do not make overwrite the default.

4. Adjust imported result persistence.
   - Ensure `persistImportedResults(...)` writes under the new project id and new run id.
   - Ensure `projectWithImportedResultRefs(...)` uses the remapped ids.

5. Update frontend expectations if needed.
   - `apps/opencae-web/src/lib/api.ts` should not assume the returned project id matches the file id.
   - `WorkspaceApp` should display the returned project and message.
   - Recommended message: `Opened <name> as a new local copy.`

6. Add tests.
   - API test: create a sample project, export or clone its JSON, mutate its name/studies to represent an older saved copy, POST `/api/projects/import`, and assert:
     - response project id differs from the original id,
     - both projects exist in `GET /api/projects`,
     - original project's studies/runs are unchanged,
     - imported artifact refs begin with the new project id.
   - API test: import with embedded results and assert result fields use the remapped run id.
   - Optional frontend API test: `importLocalProject(file)` accepts returned project id differing from file id.

## Verification Gates

Run:

```sh
pnpm --filter @opencae/api exec tsc --noEmit
pnpm test apps/opencae-api/src/server.test.ts apps/opencae-web/src/lib/api.test.ts
pnpm test
```

Expected:

- Targeted tests pass.
- Full test suite passes.
- Import collision test proves no overwrite/prune of the existing project.

## Done Criteria

- Importing a saved file with an existing project id creates a new local copy by default.
- Imported result bundles still load after id remapping.
- Artifact refs cannot point at another project's artifacts.
- Existing hostile artifact-ref tests continue to pass.

## Out Of Scope

- Do not redesign the local file format.
- Do not add accounts, permissions, or multi-user ownership.
- Do not change autosave storage keys.

## Escape Hatches

If product direction requires "Open file replaces same project" semantics, stop and add an explicit confirmation flow in the UI before overwriting. Do not keep silent overwrite behavior.
