# Plan 012: Broaden The Analytical Solver Benchmarks (Off-Axis, Frequency, Display-Invariant, Convergence)

Base commit: OpenCAE-Core (sibling) `08ca7a6`. All changes in the SIBLING repo. Independent of plan 011, but its value multiplies once 011 puts these tests in CI.
Status: TODO
Priority: 2 of the engineering-validity plans
Category: validation

## Problem

The existing accuracy gate (`services/opencae-core-cloud/tests/cantilever-accuracy.test.ts`) is genuinely good but covers ONE configuration: an axis-aligned block, bending-dominated static load, and a slow-ramp dynamic case judged only by its quasi-static end state. A July 2026 engineering audit verified the static element path as textbook-correct, but identified error classes this single gate cannot catch:

- **Axis-aligned blind spot.** Geometry, face selection ("x_min"/"x_max"), and load direction are all axis-aligned. Any latent assumption of axis alignment (face-node selection, direction handling, recovery transforms) passes today's gate.
- **No frequency/inertia verification.** The dynamic gate checks the END state, which is insensitive to mass distribution and damping. The solver internally estimates the fundamental frequency (inverse power iteration, used to calibrate Rayleigh damping — `packages/solver-cpu/src/dynamic-mdof.ts`, `resolveRayleighDamping` → `rayleighFromFrequencies`, ω₂ = 4ω₁) and uses HRZ Tet10 mass lumping (`element-tet10.ts:47-48`, fractions 1/36 vertex + 4/27 edge; 4·(1/36)+6·(4/27)=1 exactly). Nothing validates that estimated frequency against theory, so a mass-assembly or eigen-estimate regression would silently mis-calibrate damping and distort every transient peak.
- **No display-vs-summary invariant.** Summary max stress is the unaveraged element peak computed BEFORE Laplacian smoothing (verified at `packages/solver-cpu/src/results.ts` — peak from `vonMisesPeak`, smoothing only on the visualization field). No test asserts `smoothed field max ≤ summary max`, the invariant the UI's "legend ≤ summary" honesty depends on.
- **No stress-convergence signal.** The preset sweep asserts node-count monotonicity and deflection within ±5%, but not that peak stress stabilizes across refinement (BENCHMARKS.md records 43.5 → 45.2 → 46.2 MPa coarse→fine; that stabilization should be pinned).
- **No time-step adequacy signal.** Cloud dynamic solves clamp `timeStep ≥ 0.0001 s` (`services/opencae-core-cloud/src/server.ts` SOLVER_LIMITS). For the benchmark cantilever (first period ≈ 1.66 ms) that is ~17 steps/period — fine for ramps, marginal for sharp transients — and nothing surfaces the ratio to the user or diagnostics.

## Analytical Oracles (derive in-test from first principles, as the existing test does)

For the standard 180×24×24 mm steel cantilever (E=200 GPa, ν=0.29, ρ=7850 kg/m³ — confirm ρ from `packages/solver-cpu/src/material.ts` / the mat-steel definition; if the repo's steel density differs, use the repo's value in the formula):

- Tip deflection under oblique tip load F at angle θ in the y–z plane (direction `[0, sinθ, -cosθ]`): by symmetry of the square section, each transverse component bends independently — δy = (F·sinθ)·L³/(3EI) + shear term, δz analogous with cosθ; resultant magnitude equals the straight-load deflection for any θ. Use θ = 30°. Same Timoshenko shear correction (6/5) per component as the existing test.
- First bending natural frequency (Euler-Bernoulli cantilever): f₁ = (1.875104²/2π)·√(EI/(ρ·A·L⁴)). With the values above: I = 2.7648e-8 m⁴, A = 5.76e-4 m², giving f₁ ≈ 604 Hz (period ≈ 1.66 ms — matches the comment in the existing test about the "~1.7 ms first bending period"). Note the FE model includes shear flexibility and rotary inertia the E-B formula ignores (both LOWER the true f₁ a few %), and HRZ lumping perturbs it slightly — set the gate at ±10% initially and record the measured value in the assertion message.

## Implementation Steps (all in the sibling repo, one new test file + one small diagnostics addition)

1. Read the existing harness first: `services/opencae-core-cloud/tests/cantilever-accuracy.test.ts` end to end (request builder, `structuredBlockCoreModelFromRequest`, `solveCoreStatic`/`solveCoreDynamic`, CLOUD_SOLVE_OPTIONS). New tests must reuse this harness style exactly.
2. Create `services/opencae-core-cloud/tests/benchmark-extensions.test.ts` with four tests:
   a. **Oblique tip load (static, Tet10 medium):** same cantilever request but load direction `[0, Math.sin(θ), -Math.cos(θ)]`, θ=30°. Assert resultant tip displacement magnitude within ±3% of the straight-load Timoshenko value, and reaction magnitude within ±1 N of 500 N. (If the summary reports only max displacement magnitude, that IS the resultant — check how `maxDisplacement` is computed before asserting.)
   b. **Fundamental frequency (dynamic, Tet10 medium):** run `solveCoreDynamic` and read the Rayleigh calibration diagnostics (`resolveRayleighDamping` result is surfaced in the solve diagnostics — find where `calibration.fundamentalFrequencyHz` lands in the returned diagnostics object; if it is not exposed in the public result, expose it there as part of this plan — it is already computed). Assert `fundamentalFrequencyHz` within ±10% of the analytical f₁.
   c. **Display invariant:** solve static Tet10 medium; locate the smoothed visualization stress field and the summary max in the result; assert `max(visualization stress values) ≤ summary.maxStress × (1 + 1e-9)`.
   d. **Stress stabilization across presets:** run coarse/medium/fine; assert |vm_fine − vm_medium| < |vm_medium − vm_coarse| + small slack, and vm_fine within ±10% of vm_medium (pins the BENCHMARKS.md stabilization pattern without demanding strict monotonicity).
3. **Time-step adequacy diagnostic:** in `packages/solver-cpu/src/dynamic-mdof.ts`, where ω₁ is already estimated for Rayleigh calibration, compute `stepsPerFundamentalPeriod = (2π/ω₁)/settings.timeStep` and include it in the solve diagnostics next to the calibration record. Do NOT clamp or change the time step. Add one unit assertion in test (b) that the field is present and ≈ (1/f₁)/timeStep.
4. Update `BENCHMARKS.md` with a short section listing the new gated cases and their oracles.
5. Run: `pnpm -C services/opencae-core-cloud test` (and the solver-cpu package tests if step 3 touched them). All green, including the pre-existing suite.

## Verification Gates

```sh
pnpm -C <sibling>/services/opencae-core-cloud test
pnpm -C <sibling> typecheck
```

Expected: exit 0; the four new tests listed in output; existing cantilever suite unchanged and green.

## Done Criteria

- Four new gated assertions exist with analytical oracles derived in-code (no magic expected values without derivation comments).
- `stepsPerFundamentalPeriod` appears in dynamic solve diagnostics.
- No solver numerical behavior changed (only diagnostics exposure); existing tests pass with unchanged tolerances.

## Out Of Scope

- Real-geometry/gmsh benchmarks (plan 013). CI wiring (plan 011). Solver fixes — if a new gate FAILS, that is a discovery, not a license to change solver code (see Escape Hatches).
- The open-cae repo entirely.

## Maintenance Note

These oracles assume the repo's mat-steel property values; if material data changes, the tests recompute from the same constants and stay valid. The frequency tolerance (±10%) can tighten once a baseline is recorded — note the measured value in the first PR.

## Escape Hatches

- Any new gate fails at `08ca7a6`+current main → STOP and report the measured vs analytical values with the derivation; do not adjust solver code or bury the failure in a loose tolerance. (A frequency miss beyond ±10% most likely implicates mass lumping or the eigen-estimate and is exactly the finding the maintainer needs to see.)
- If the calibration diagnostics are structurally hard to expose without touching public API shapes, report the coupling and land tests (a), (c), (d) alone.
- If the summary reports per-axis rather than resultant displacement for (a), derive the correct per-component oracle instead of forcing the magnitude comparison.
