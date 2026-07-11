# Plan 018: Surface the Fix-Open-Surfaces Action After Mesh Failures + Honest Geometry Errors

Base commit: open-cae `2f42af2`.
Status: TODO
Category: meshing robustness / honest-failure UX
Driver: real-world session (2026-07-10, Corning Seed Holder 8PC v7-2 CAE_TEST.step, 1 body / 428 faces) hit a dead end: mesh failed with "Open STEP surfaces remain after sewing and boundary patching… Use Fix open surfaces on the Model step", but the Model step showed no such button.

## Problem

Three defects compound into a dead end for STEP parts that import as a *nominal* solid but cannot be re-sewn at repair tolerance:

1. **Dead-end pointer.** The "Fix open surfaces" card renders only when `stepGeometry.status === "repairable"` (`apps/opencae-web/src/components/RightPanel.tsx:247`, mirrored on the Mesh panel at `:1044`), and that status is written exactly once — at upload, by `inspectStepGeometryForUpload` (`apps/opencae-web/src/lib/api.ts:374`). The Corning part imports with a volume and a valid surface mesh, so inspection says `"solid"` and no card ever appears. A later mesh failure only logs a message (`apps/opencae-web/src/WorkspaceApp.tsx:1612`); nothing re-evaluates repairability. The error text added in `2f42af2` therefore points at a button that does not exist for exactly the class of part most likely to hit this error.

2. **Misleading diagnosis + masked root error.** In the quality-repair ladder (`libs/opencae-mesh-intake/src/wasmMesher.ts:281-311`), `repairImportedStepGeometry` runs `occ.healShapes` (sew tolerance capped at 0.05 mm) and throws "no solid volume could be created" when `repairedVolumeCount === 0` (`wasmMesher.ts:854`) — even when `originalVolumeCount > 0`, i.e. the import HAD a solid and *healing destroyed it*. Because `meshStepToMshV2` throws `lastError` (`wasmMesher.ts:313`), this repair-path complaint replaces attempt 1's real 3D-mesh failure. The user is told the file has open surfaces when the truth is "the 3D mesher failed on your (nominally closed) geometry, and automatic repair could not improve it."

3. **Sequence recap for reference** (from the session log): attempt 1 imports OK → 2D mesh OK → `generate(3)` fails fast → `preferQualityRepair` trips (428 faces ≥ `COMPLEX_SEAM_REPAIR_SURFACE_THRESHOLD` 128, open boundary curves > 0, `wasmMesher.ts:529`) → repair attempts at 6 mm and 5 mm both lose the solid in `healShapes` → user sees the open-surfaces error and a phantom-button pointer.

## Changes

### A. Honest error when healing loses an existing volume (mesh-intake lib)

In `repairImportedStepGeometry` (`libs/opencae-mesh-intake/src/wasmMesher.ts:854`), when `repairedVolumeCount === 0`:

- If `originalVolumeCount > 0`, throw a DISTINCT `StepGeometryError` (add a machine-readable marker — a dedicated `name` or an exported error-code field, follow the existing `NETGEN_CRASH_ERROR_NAME` pattern at `:343`) saying automatic geometry repair could not re-sew the model and was discarded, e.g. "Automatic geometry repair could not re-close this model's faces (sew tolerance 0.05 mm), so the repaired attempt was discarded." Keep the existing message for the genuinely-never-had-a-volume case.
- In `meshStepToMshV2`'s quality-repair loop (`:284-310`), when a repair attempt fails with that heal-lost-the-volume error, DO NOT let it become the surfaced `lastError` if an earlier standard-ladder error exists — prefer attempt 1's real mesh error and append a one-line note that bounded automatic repair was also tried and failed. Concretely: capture `standardLadderError` before entering the repair loop and compose the final thrown error from both, root cause first.
- Preserve the "Use Fix open surfaces on the Model step, or re-export the part from CAD as a solid body" pointer on whichever composed error is thrown when the geometry is implicated (both branches), since after change B the pointer will actually be true.

### B. Re-probe repairability after a geometry mesh failure (web app)

When `onGenerateMesh` fails (`apps/opencae-web/src/WorkspaceApp.tsx:1605-1614`) with a geometry-class error:

1. Detect geometry-class failures. The worker boundary serializes errors, so don't rely on `instanceof` across it — check how mesh worker errors rehydrate (`apps/opencae-web/src/workers/meshWorkerClient.ts` / `meshWorker.ts`) and propagate a stable marker (error `name` survives most serializers; verify, and thread it through explicitly if not).
2. On a geometry-class failure for an uploaded STEP model whose current `stepGeometry.status` is `"solid"` or `"unchecked"`, run the SAME repairability probe the upload path uses — `client.inspectStepFileInWorker` on the embedded STEP bytes (reuse `inspectStepGeometryForUpload`'s mapping at `api.ts:383-388`; extract a shared helper rather than duplicating the status mapping) — and write the refreshed `stepGeometry` metadata onto the project via the existing `attachStepGeometryMetadata` shape (`api.ts:397`). NOTE: the probe proves repairability by actually running `repairStepGeometry` in the worker (`apps/opencae-web/src/workers/meshWorker.ts:93-102`), which for a 428-face part costs seconds — run it AFTER the failure is already displayed, show it as a follow-up log line ("Checking whether Fix open surfaces can repair this model..."), and guard with the current model-mutation generation so a replace/upload during the probe discards the result (follow `assertCurrentModelMutation` usage in `api.ts`).
3. Inspection caveat: `inspectStepGeometry` returns `"solid"` for this class of part (volume + valid 2D mesh), and the worker only runs the repair probe for `"open_shell"` (`meshWorker.ts:93`). So a plain re-inspection would change nothing. Extend the worker's `inspectStepFile` operation (or add a sibling operation) with a `probeRepairEvenIfSolid` flag: when set and status is `"solid"`, still trial-run `repairStepGeometry`; report `repairable` accordingly. Map that result to status `"repairable"` (button appears; pressing it re-uploads healed bytes and resets face-bound setup — existing flow at `api.ts:341`) or `"unrepairable"` (both panels then show the honest "re-export from CAD" warning instead of a phantom pointer).
4. Keep the existing `stepGeometryResolvedByMesh` quieting (`RightPanel.tsx:1041`): a later successful mesh must still suppress the card.

### C. Error-text truthfulness pass

- `"repairable"` after a mesh failure: card copy already fits ("Fix model sews small gaps and may patch closed boundary loops…").
- `"unrepairable"` after a mesh failure: ensure the mesh-failure log line does NOT keep recommending Fix open surfaces once the probe has proven it can't help — when the refreshed status is `"unrepairable"`, push a follow-up line: "Automatic repair cannot close this model. Re-export it from CAD as a solid body (stitch/heal in CAD; the gaps exceed the 0.05 mm in-app sew tolerance)."

## Implementation Steps

1. Lib: split the `repairedVolumeCount === 0` throw in `repairImportedStepGeometry` by `originalVolumeCount`, add the machine-readable marker, and adjust `meshStepToMshV2` lastError composition (change A). Unit tests in `libs/opencae-mesh-intake/src/stepGeometryRepair.test.ts` alongside the existing repair tests: (a) heal-destroys-volume input surfaces the standard-ladder error first with the repair note appended; (b) never-had-a-volume input keeps the current message.
2. Worker: add the `probeRepairEvenIfSolid` path to `inspectStepFile` (change B3) + a test if the worker has any (check for existing worker-level tests; if none, cover via the lib entry points).
3. App: geometry-failure detection + post-failure probe + metadata refresh in the `onGenerateMesh` catch (change B1/B2), reusing a helper extracted from `inspectStepGeometryForUpload`. Wire the follow-up log lines (change C).
4. UI tests: extend `apps/opencae-web/src/components/RightPanel.test.tsx` — after a project's `stepGeometry` flips to `"repairable"`, the card renders on Model and the warning on Mesh; `"unrepairable"` renders the re-export warning.
5. Manual verification with the Corning STEP (ask Peter for the file or use any nominal-solid-that-won't-sew fixture): mesh → failure → probe runs → card or honest re-export message appears; pressing Fix open surfaces either produces a meshable healed body or the unrepairable path reads truthfully.

## Verification Gates

```sh
pnpm -C libs/opencae-mesh-intake test
pnpm -C apps/opencae-web test
pnpm -C apps/opencae-web typecheck   # NOTE: pre-existing tsc/build failure in localCantilever test (see memory) — gate on no NEW errors
```

## Done Criteria

- A STEP that imports as a nominal solid but fails 3D meshing + re-sew no longer dead-ends: the Model/Mesh steps show Fix open surfaces (probe-proven) or the honest re-export message (probe-disproven).
- The surfaced mesh error for that class of part leads with the real 3D-mesh failure, not "open surfaces remain", and never recommends an action the probe has disproven.
- No behavior change for parts that inspect as `"repairable"`/`"unrepairable"` at upload, for successful meshes, or for the sample/procedural paths.

## Out Of Scope

- Raising the 0.05 mm sew-tolerance cap or adding a user-tunable tolerance (candidate follow-up plan; would need bounds-change guard rework).
- The repeating "no confident match: Top face" heal spam and placeholder-selection creation on uploaded models (separate task chip already filed).
- Autosave browser-storage quota exhaustion for large embedded STEP files.
