# 022 — OpenCAE Medium-Feature Roadmap — Flagship First

## Status

In progress on `codex/022-medium-feature-roadmap`.

| Increment | Status | Release gate |
| - | - | - |
| 1. Modal analysis | Released (2026-07-14) | 285 focused tests, typecheck, build, 1,263-test full suite |
| 2. Open section and project custom materials | Released (2026-07-14) | 372 focused tests, typecheck, build, 1,279-test full suite |
| 3. Static/dynamic cases, combinations, envelopes | Released (2026-07-14) | 361 focused tests, typecheck, build, 1,308-test full suite |
| 4. Static mesh-convergence studies | Released (2026-07-14) | 265 focused tests, typecheck, build, 1,319-test full suite |
| 5. Advanced loads and equivalent bolt preload | Pending | Same gate |

The plan runs after the result-identity, cache-key, and barycentric-probe foundation from plan 021 Stage 1. The browser solve limit is 100,000 DOF and must always be passed through `@opencae/solve-pipeline`; the solver package's internal 30,000-DOF default is not the product limit.

## Increment 1 — Modal analysis

- Add `modal_analysis` studies with 1–10 requested modes and a default of 6. Density, a mesh, and supports are required; applied loads are not.
- Share sparse stiffness, constraints, and HRZ lumped-mass assembly with dynamic analysis.
- Solve with deterministic block shift-invert subspace iteration, two-pass M-orthonormalization, Rayleigh–Ritz projection, and scaled residual tolerance `1e-6` for at most 30 iterations.
- Return converged modes only, sorted by frequency. Normalize each exported vector shape to maximum nodal magnitude 1 and fix its sign using the largest absolute component.
- Translate singular or unconstrained systems into a Supports-step diagnostic. Never expose raw CG failure as the user-facing modal error.
- Reuse the shared one-mode routine for Rayleigh damping calibration and retain a regression against the retired one-vector estimate.
- Export normalized vector `mode_shape` surface fields and a modal result summary. Mode identity participates in selector, series, packed-playback, and cache keys.
- Show a mode table and synthesize 24 sinusoidal phase frames in the browser. Phase and amplitude are visualization-only, not displacement.

## Increment 2 — Open section and project custom materials

- Store one optional X/Y/Z clipping plane in workspace UI autosave state, with normalized offset and cut-side flip. It is deliberately absent from portable project data.
- Enable Three.js local clipping for model geometry, mesh overlays, solver/result materials, feature-edge line segments, and undeformed outlines. Loads, supports, probes, dimensions, and other annotations stay outside the clipping roots.
- Render the visible `Open section` label inside the WebGL scene so report/project captures include it whenever clipping is active.
- Add optional project-scoped UUID custom materials. Canonical storage remains Pa and kg/m³; SI/US conversion happens only at the editor boundary.
- Duplicate starter or custom materials with copied additive print profiles. Custom materials without a print profile receive only an unvalidated CNC/bulk path.
- Mark every custom definition `user_supplied_unverified`, preserve it through autosave and version-2 portable files, and show the warning in the library and reports.
- Resolve material IDs through one built-in-plus-project catalog in UI, validation, browser/API solver adapters, mesh intake, and reports. Explicit unknown IDs fail clearly and never fall back to Aluminum 6061.
- Editing an assigned custom material clears stale results. Deletion is disabled and guarded while any study assigns the material.

## Increment 3 — Static and dynamic load cases

- Add structurally shared support/material/mesh load cases to static and dynamic studies. Every load belongs to exactly one case; legacy studies migrate to one enabled `Default` case without changing their solve.
- Add finite signed static combinations that reference cases directly. Nested combinations and all dynamic combinations are rejected by schema and study validation.
- Split static solving into prepare, solve, and recover stages. Assemble and reduce stiffness once, warm-start each case from the previous displacement, and recover raw displacement, reaction, strain, and six-component stress tensors.
- Superpose only raw vectors and tensors for combinations, then recompute von Mises, principal stresses, and maximum shear. Preserve exact numeric parity for legacy fields while treating the tensor-derived measures as additive result fields.
- Create one static envelope across enabled cases and combinations. Stress takes the maximum recovered von Mises; displacement retains the complete vector from the variant with the largest magnitude; compact governing-variant indices feed probe tooltips.
- Reuse shared stiffness, mass, and Rayleigh assembly for dynamic cases while starting each case from zero state. Stream completed cases through the solve worker and persist them independently in IndexedDB so aggregate transient payloads are not retained.
- Store case, combination, and envelope payloads as `RunVariantResult` entries over one shared surface mesh. Active variant identity now participates in field selection, probes, series, and packed-playback cache keys.
- Keep portable container version 2 and parse old structural result bundles as one `Default` variant. Partial IndexedDB variant records are removed after cancellation or failure.
- Add the case/combination editor and result-variant selector. Disabled cases remain editable but do not solve, and dynamic studies expose cases without combination/envelope controls.
- Thread the 100,000-DOF browser limit through every variant pipeline and preserve the honest browser-limit diagnostic on case results.

## Increment 4 — Static mesh-convergence studies

- Add project-persisted convergence records for one selected static load case. Run the isolated `coarse -> medium -> fine` ladder without changing the working study's selected mesh or active results; `ultra` stays outside automatic v1 studies.
- Default an explicit displacement probe to the primary case-load application point. Map it to the nearest solver-surface triangle with model-scale tolerance and reuse barycentric vector interpolation; a point that cannot map fails that rung honestly.
- Preflight every generated Core mesh for actual node/element counts, total/free DOF, and representative mesh size. Import the authoritative 100,000-DOF cap through a lightweight solve-pipeline limits entry point and skip over-limit meshes before entering the solve worker.
- Persist only compact rung metrics: requested preset, actual counts and size, raw element peak von Mises stress, probe displacement magnitude, status, and skip/failure reason. Full rung meshes and result fields remain transient.
- Continue after individual mesh, solve, or mapping failures. Classify only three successful strictly increasing-DOF rungs; medium-to-fine changes at or below 5% displacement and 10% stress are labeled apparent convergence, threshold misses are unconverged, and missing/non-monotonic ladders are inconclusive.
- Add a static-case/probe control and lightweight SVG plot of both metrics against actual DOF, including skipped/capped markers and the compact persisted rung details.
- Preserve the version-2 portable container and workspace autosave behavior with optional convergence records. Keep convergence meshing local-only so fallback paths cannot mutate the API-owned working study.

## Remaining increment

5. Add consistently integrated surface traction and volume force, rank-checked distributed remote wrench loads, and static-only equivalent bonded-linear bolt preload. Preserve exact resultant/moment diagnostics and reject missing geometry mappings.

## Compatibility and delivery

- OpenCAE Core schema `0.3.0` adds modal steps first and will add the advanced load primitives in increment 5. Readers continue accepting `0.1.0` and `0.2.0`.
- The portable `opencae-local-project` container remains version 2; new project fields are optional.
- Result APIs are a structural/modal union. Legacy single-result bundles remain readable.
- Each increment receives focused tests, `pnpm typecheck`, `pnpm build`, and one full `pnpm test`, followed by a short imperative commit and push.
- Stage only increment-owned files. Never blanket-add or revert `libs/opencae-core-adapter`.
