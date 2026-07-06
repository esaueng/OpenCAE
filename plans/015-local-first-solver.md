# Plan 015: Local-First Browser Solver Parity And Cloud-Solve Wind-Down

Base state: open-cae `main` after the local Core worker/path work. The upstream solver packages are pinned by `services/opencae-core-cloud/OPENCAE_CORE_REF`.
Status: IN PROGRESS
Priority: local-first migration track, part B
Category: product correctness / architecture

## Problem

The browser already has a real OpenCAE Core solve path (`opencae_core_local`), but it is not yet an honest replacement for Core Cloud:

- Browser static/dynamic solves need the same model-building semantics as the deployed runner: surface sets, pressure/gravity handling, solver-frame remap, validation, and provenance.
- Dynamic browser solves can request legal frame counts while hiding impossible Newmark step counts. The cloud runner has a container timeout; the browser needs an explicit preflight and visible diagnostics.
- Local result persistence is weaker than R2-backed cloud results; large result bundles can disappear on reload if localStorage quota writes fail.
- Cloud solve removal must be staged. The Worker cloud routes still serve cloud meshing until in-browser WASM meshing lands.

## Desired Behavior

- Eligible studies default to the local browser solver; complex geometry without a local Core volume mesh stays on Core Cloud until plan 016 lands.
- Local solves fail fast with clear diagnostics when browser limits are exceeded. No timed fake progress, no estimate fallback, no silent hangs.
- Local result bundles survive reload through IndexedDB/OPFS or a deterministic re-solve mechanism with visible quota failure UX.
- Cloud solve client code is removed only after the local path has parity gates. Cloud infrastructure is removed only after in-browser meshing is complete.

## Implementation Steps

1. **Golden fixtures.**
   - Record deployed Core Cloud results for cantilever, beam/bracket, and one dynamic case.
   - Store under `apps/opencae-web/src/testdata/core-cloud-golden/`.
   - Add characterization tests for fields, units, provenance, surface mesh alignment, and solver-frame render vectors.
2. **Upstream solver hooks.**
   - In `../opencae-core`, extend solver options with progress and cancellation hooks.
   - Thread hooks through static CG iterations, dynamic output-frame loops, and assembly progress.
   - Replace `Map<number, number>[]` sparse assembly with typed-array COO -> sort/merge CSR before raising browser defaults beyond 60k DOF.
   - Bump `OPENCAE_CORE_REF` only after the upstream tests pass.
3. **Browser pipeline parity.**
   - Keep local solves on `buildOpenCaeCoreCloudModelForStudy` semantics.
   - Preserve `displayDirectionToSolverFrame()` and solver-space result rendering.
   - Keep the staged browser cap at 60k DOF until the typed-array builder and a WebKit target-scale run land.
   - Surface the deliberate dynamic deviations: browser transient field budget and hard step-count cap.
4. **Dedicated solve worker.**
   - Keep solve work isolated from STL decode/playback workers.
   - Worker emits real run events and supports cancellation by cooperative hooks when available, with terminate/respawn fallback.
   - Single-flight local solve semantics stay enforced in the controller.
5. **Dynamic runtime preflight.**
   - Reject excessive Newmark step counts before starting the worker.
   - Warn for runs likely to take minutes; omit ETA when not derivable.
   - Cancellation produces exactly one terminal event.
6. **Persistent local results.**
   - Move result bundles out of memory/localStorage-only flow.
   - Prefer IndexedDB/OPFS bundle storage; alternatively persist deterministic inputs and re-solve on open with a visible diagnostic.
   - Add quota-failure UX and a load-old-project regression.
7. **Route default by eligibility.**
   - Default local only when `openCaeCoreEligibility()` passes.
   - Keep existing backend schema aliases for old project files.
8. **Cloud wind-down.**
   - B4a: remove client cloud-solve branches and tests after parity gates pass.
   - B4b: remove Worker routes, container binding, R2, tokens, health checks, and `services/opencae-core-cloud/` only after plan 016 A-M4.
   - B5: remove user-selectable cloud UI and add a source-sweep guard. Historical cloud results remain labeled as historical provenance, not as a selectable backend.

## Current Slice Landed

- Added a browser dynamic step-count preflight for local solves.
- Oversized dynamic studies now fail before the worker starts, with `opencae-core-local-dynamic-step-budget` diagnostics.
- Accepted dynamic browser solves carry diagnostics describing the local step cap and transient field budget.

## Verification Gates

```sh
PATH=/Users/userzero/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH node_modules/.bin/vitest run apps/opencae-web/src/lib/api.test.ts apps/opencae-web/src/workers/opencaeCoreSolve.test.ts apps/opencae-web/src/workers/localCantileverAccuracy.test.ts
pnpm typecheck
pnpm test
```

Additional gates before B4a/B5:

- Golden fixture comparison: Node/V8 exact to about `1e-12`; Playwright WebKit/Firefox about `1e-8`.
- Rendering parity through `resultVertexMapping.test.ts` / `CadViewer.results.test.ts`.
- Old-project regression for cloud run ids and historical cloud result bundles.
- Offline local solve asserts zero `/api/cloud-core/*` requests.
- Bundle guard proves no cloud client solve code ships after B5.

## Done Criteria

- Local browser results match recorded Core Cloud fixtures within the stated numeric tolerances.
- Dynamic long-run settings fail fast or warn honestly; no browser solve enters an unbounded hour-scale path.
- Local result persistence survives reload or reports a visible quota/re-solve diagnostic.
- Cloud solve is invisible in new UI after B5, with historical labels preserved for old results.

## Out Of Scope

- In-browser STEP/Gmsh meshing and face attribution; see plan 016.
- Licensing decisions for Gmsh WASM.
- Professional engineering certification of solver output.

## Rollback

- Before B4a, cloud remains the fallback/default for ineligible geometry.
- B4a and B4b must land as separate commits so client-code removal and infrastructure removal can be reverted independently.
- Last known Core Cloud runner image: 0.1.6.
