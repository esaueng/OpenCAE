# 022 — OpenCAE Medium-Feature Roadmap — Flagship First

## Status

In progress on `codex/022-medium-feature-roadmap`.

| Increment | Status | Release gate |
| - | - | - |
| 1. Modal analysis | Released (2026-07-14) | 285 focused tests, typecheck, build, 1,263-test full suite |
| 2. Open section and project custom materials | Pending | Same gate |
| 3. Static/dynamic cases, combinations, envelopes | Pending | Same gate |
| 4. Static mesh-convergence studies | Pending | Same gate |
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

## Remaining increments

2. Add one persistent workspace-only axis-aligned open-section plane, clip result/geometry/edge/outline materials, and add project-scoped UUID custom materials with canonical Pa and kg/m³ storage and centralized resolution.
3. Add structurally shared support/material/mesh load cases, static combinations and envelopes, shared prepare/solve/recover assembly, independent dynamic cases, streamed persistence, and variant-aware result identities.
4. Add project-persisted coarse-to-medium-to-fine static convergence records using barycentric displacement probes, the 100k-DOF cap, actual mesh/DOF counts, raw peak stress, and apparent-convergence thresholds of 5% displacement and 10% stress.
5. Add consistently integrated surface traction and volume force, rank-checked distributed remote wrench loads, and static-only equivalent bonded-linear bolt preload. Preserve exact resultant/moment diagnostics and reject missing geometry mappings.

## Compatibility and delivery

- OpenCAE Core schema `0.3.0` adds modal steps first and will add the advanced load primitives in increment 5. Readers continue accepting `0.1.0` and `0.2.0`.
- The portable `opencae-local-project` container remains version 2; new project fields are optional.
- Result APIs are a structural/modal union. Legacy single-result bundles remain readable.
- Each increment receives focused tests, `pnpm typecheck`, `pnpm build`, and one full `pnpm test`, followed by a short imperative commit and push.
- Stage only increment-owned files. Never blanket-add or revert `libs/opencae-core-adapter`.
