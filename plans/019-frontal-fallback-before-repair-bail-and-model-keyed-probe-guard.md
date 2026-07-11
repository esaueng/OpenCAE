# Plan 019: Try Frontal Before the Quality-Repair Bail + Model-Keyed Repair-Probe Guard

Base commit: open-cae `fa2ae84` (plan 018 implementation).
Status: TODO
Category: meshing robustness / honest-failure UX
Driver: 2026-07-10 09:31 re-test of Corning Seed Holder 8PC v7-2 CAE_TEST.step after plan 018 deployed. The honest error now shows the true root failure — `gmshModelMeshGenerate: PLC Error: A segment and a facet intersect at point` — and exposed two remaining defects.

## What the re-test proved

Plan 018 works as designed: the surfaced error leads with attempt 1's real Delaunay 3D failure and appends the repair-was-tried-and-discarded note. The root cause is NOT open surfaces — it is a **Delaunay boundary-recovery failure on a self-intersecting surface mesh** (classic PLC segment/facet intersection), on a part that imports as a nominal solid.

## Problem 1 — the Frontal fallback never runs for high-face-count parts

`meshStepToMshV2`'s own doc comment (`libs/opencae-mesh-intake/src/wasmMesher.ts:210-218`) says the single-threaded WASM Delaunay's boundary recovery is the documented weakness and `Mesh.Algorithm3D = 4` (Frontal) is the fallback. But in `meshStepAlgorithmCandidates` (`wasmMesher.ts:477-479`), when the Delaunay attempt THROWS and the error is quality-repair-recommended, the function returns immediately — **before the `frontal` loop iteration runs**. `meshStepSession` wraps EVERY failure in `qualityRepairRecommendedError` whenever `preferQualityRepair` was set at import (`:689`), and that flag trips for any part with ≥ 128 surfaces + open boundary curves (`COMPLEX_SEAM_REPAIR_SURFACE_THRESHOLD`, `:577`). The Corning part has 428 faces, so:

- Delaunay fails with the PLC error → immediate bail to quality repair. Frontal never tried.
- The quality-repair sessions pin `Mesh.Algorithm3D = 1` (Delaunay) explicitly (`meshStepSession`, repairProfile `"quality"` branch), so no path in the entire ladder ever tries Frontal on this class of part.
- Timeline evidence: 2D mesh done 09:30:58, retry-2 (repair) phase already at 09:30:59 — no time for a Frontal candidate.

The one algorithm most likely to mesh this part is the only one never attempted. Note the skip-comment at `:505-508` justifies skipping further attempts only when a *completed* mesh has residual seam quality issues — it does not apply to a thrown Delaunay error.

### Fix

In `meshStepAlgorithmCandidates`, when the `delaunay` iteration throws a quality-repair-recommended error, do NOT return — record `delaunayError` and continue to the `frontal` iteration. Return `{ ..., preferQualityRepair: true }` only after Frontal has also failed or produced a sub-floor mesh. Keep the existing early return for the case where a *completed* result carries `preferQualityRepair` (`:502-508` path) — that reasoning (seam slivers need healing, not another algorithm) is sound for completed meshes.

Cost note: one extra gmsh session (~import + mesh2d + mesh3d) only in the failure path of complex parts, before two repair sessions that are already paid today. Net wall-clock change is bounded and buys a chance of success instead of a guaranteed dead end.

Also update the composed failure message expectation: with Frontal now attempted, `stepMeshFailureAfterRepairAttempt` composes from `standardLadderError` which is whatever `meshStepWithAlgorithmFallback` threw — make sure that error reflects BOTH algorithm failures (the `:437-440` composition already exists for the repairGeometry branch; reuse or mirror it) so the user sees "Delaunay: PLC …; Frontal: …" rather than only one.

## Problem 2 — the repair probe is silently skipped by any concurrent project mutation

The 09:31:12 failure log contains NO "Checking whether Fix open surfaces can repair this model..." line. Cause: the user clicked Save at 09:30:58 (mid-mesh). `handleSaveProject` replaces the project object (`setProject((current) => ({ ...current, updatedAt: savedAt }))`, `apps/opencae-web/src/WorkspaceApp.tsx:987`), so the probe guard `projectRef.current !== sourceProject` (`WorkspaceApp.tsx:1036`) saw a different object identity and returned **silently** — no probe, no message, and the error text still points at a Fix open surfaces button that was never surfaced.

Meshing on real parts takes 15+ seconds; users saving (or renaming, or touching anything that clones the project) during that window is normal, not exceptional.

### Fix

Key the guard on what actually matters — same uploaded model — not whole-project object identity:

1. Extract a model-identity check: the embedded STEP geometry file entry (e.g. the `geometryFiles` local-upload entry's `embeddedModel.contentBase64` reference or filename+size) unchanged between `sourceProject` and `projectRef.current`. `updatedAt` bumps and study edits must NOT disqualify the probe.
2. When identities differ only in project-level metadata, run the probe against `projectRef.current` (the live object) so the metadata write lands on the current project state; the existing `actionHandle.isCurrent()` + generation guard already covers replace/upload races mid-probe.
3. If the probe is skipped because the MODEL genuinely changed, log it ("Skipped the Fix open surfaces check because the model changed during meshing.") — never skip silently while the error text recommends the action.

## Implementation Steps

1. Lib (`wasmMesher.ts`): rework the `:477-479` early return per Problem 1; compose both algorithm errors into the standard-ladder error. Extend `libs/opencae-mesh-intake/src/stepGeometryRepair.test.ts` (or the mesher test suite) with an orchestration test: a delaunay-throws + preferQualityRepair scenario must still invoke the frontal candidate (assert via injected session spy or the exported orchestration helpers, matching how existing tests fake sessions).
2. App (`WorkspaceApp.tsx` + helper in `lib/api.ts` or `stepGeometryState.ts`): replace the object-identity guard with the model-identity check; add the skip log line; probe against the live project. Unit test in `apps/opencae-web/src/lib/api.test.ts` for the identity helper (updatedAt bump → still probes; replaced model → skips with reason).
3. Re-test with the Corning STEP: expect either (a) Frontal succeeds → part meshes, or (b) Frontal also fails → error shows both algorithms AND the probe line + verdict ("Fix open surfaces is available…" or the unavailable message) actually appears even if the user saves mid-mesh.

## Verification Gates

```sh
pnpm -C libs/opencae-mesh-intake test
pnpm -C apps/opencae-web test
pnpm -C apps/opencae-web typecheck   # gate on no NEW errors (pre-existing localCantilever failure)
```

## Done Criteria

- A ≥128-face part whose Delaunay 3D throws gets a Frontal attempt before any quality-repair bail; the composed failure message names both algorithms' errors when both fail.
- Saving (or any non-model project mutation) during meshing no longer suppresses the post-failure repair probe; a genuinely changed model logs the skip reason.
- No behavior change for completed-but-sub-floor meshes (existing `preferQualityRepair` result path) or for parts below the complex-seam threshold.

## Out Of Scope

- Attempting Frontal inside the quality-repair sessions (MeshAdapt/Delaunay pin there is deliberate and test-backed).
- Sew-tolerance changes (still a candidate separate plan).
- Any attempt to auto-fix self-intersecting B-rep faces; if Frontal also fails, CAD re-export remains the honest answer.
