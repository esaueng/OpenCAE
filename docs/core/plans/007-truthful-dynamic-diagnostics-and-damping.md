# 007 — Truthful dynamics: honest damping, real reaction balance, trustworthy convergence reporting

- **Status:** TODO — land **after plan 003** (its cross-solver/invariant tests are the regression net; this plan also deliberately changes some diagnostic values that existing tests may pin)
- **Written against source commit:** `292a6eb` (branch `improvement-plans` at `2fec8c0` adds only `plans/`). Re-verify excerpts if source changed; on mismatch STOP and report drift.
- **Category:** engineering-validity (numerics / diagnostics / interpretation)
- **Effort:** M
- **Risk of change:** medium (changes diagnostic semantics and default damping *reporting*; solver displacement/stress outputs unchanged except where noted)

## Why this matters

Three places where the numbers presented to users do not mean what their names say. The solve math itself was independently verified correct (Newmark average-acceleration algebra, Rayleigh C = αM + βK applied with the full stiffness matrix, initial acceleration, von Mises formula) — this plan is about the **reporting and the damping default**, not the integrator.

1. **The default damping mapping does not deliver the requested damping ratio.** With `C = αM + βK`, modal damping is `ζ_eff(ω) = α/(2ω) + βω/2`. The fallback `α = 10·ζ`, `β = 1e-4·ζ` gives `ζ_eff(ω) = ζ·(5/ω + 5e-5·ω)`, which equals the requested `ζ` only near ω ≈ 5 rad/s (0.8 Hz) and ω ≈ 2×10⁴ rad/s (3.2 kHz). At 50 Hz (ω ≈ 316 rad/s) the delivered damping is **ζ·0.032 — about 31× less than requested**; at 0.1 Hz it is ~8× more. A user setting `dampingRatio: 0.05` on a typical structure gets ~0.16% damping with no indication. The constants are undocumented and unitful (rad/s and s).

2. **`reactionBalance` in dynamic diagnostics is not a reaction balance.** It is populated with the CG solver's relative residual — an algebraic linear-solve quantity. A reader sees `relativeImbalance: 1e-11` and concludes force equilibrium was verified; it was not. Meanwhile the static path computes a **true** reaction-vs-applied balance (`computeReactionBalance`, solver.ts) but nothing ever checks or warns on it.

3. **Dynamic top-level diagnostics hardcode `converged: true` and `relativeResidual: 0`**, and CG's reported residual is the recurrence value, never recomputed from `b − Ax`. Additionally the CG convergence denominator is `max(‖b‖, 1)` — a **unit-dependent** criterion: for load vectors with norm < 1 (small forces in SI units), the test silently becomes absolute-vs-1-Newton instead of relative, so CG can report success with a residual that is large relative to the actual load.

## Current state (verified excerpts)

Damping fallback — `packages/solver-cpu/src/dynamic-mdof.ts:104-105`:

```ts
const rayleighAlpha = settings.rayleighAlpha ?? (settings.dampingRatio > 0 ? settings.dampingRatio * 10 : 0);
const rayleighBeta = settings.rayleighBeta ?? (settings.dampingRatio > 0 ? settings.dampingRatio * 1e-4 : 0);
```

Mislabeled balance — `packages/solver-cpu/src/dynamic-mdof.ts:186-191`:

```ts
reactionBalance: convergence.map((entry) => ({
  frameIndex: entry.frameIndex,
  timeSeconds: entry.timeSeconds,
  loadScale: loadScaleAt(entry.timeSeconds, settings),
  relativeImbalance: entry.relativeResidual
})),
```

Hardcoded convergence — `dynamic-mdof.ts:160` (`relativeResidual: 0`) and `:164` (`converged: true`).

True balance computed but unchecked — `packages/solver-cpu/src/solver.ts:602-620` (`computeReactionBalance` returns `appliedLoad`, `reaction`, `imbalance`, `relativeError`; stored in static diagnostics at solver.ts:405; no threshold check anywhere).

Unit-dependent CG denominator — `packages/solver-cpu/src/sparse.ts:157`:

```ts
const rhsNorm = Math.max(norm(rhs), 1);
```

CG residual is recurrence-only (never recomputed): `sparse.ts:183-185, 196-205`. Note `computeReactionBalance` (solver.ts:613) and the residual helper (solver.ts:~595) use the same `Math.max(reference, 1)` pattern.

Per-frame reaction forces already exist: `computeReactionForce(system, displacement, loadScale)` is called for every frame (`dynamic-mdof.ts:354`) and stored on the frame — the data for a true per-frame balance is already computed.

## Conventions to match

- Result-object errors (`{ ok: false, error: { code, message } }`); diagnostics are plain data on `DynamicTet4CpuDiagnostics` / `CpuSolverDiagnostics` (`packages/solver-cpu/src/types.ts`). Additive fields preferred; renames are breaking.
- Tests in `packages/solver-cpu/tests/{dynamic.test.ts,sparse.test.ts,solver.test.ts}` — match style.
- TypeScript strict, ESM, no new dependencies.

## Steps

### Step 1 — True per-frame reaction balance in dynamic diagnostics

Export `computeReactionBalance` from `solver.ts` (it is currently module-private; check `packages/solver-cpu/src/index.ts` re-export conventions). In `dynamic-mdof.ts`, for each **emitted frame**, compute the true balance from the frame's already-computed `reactionForce` and the scaled applied load (`loadScale * fullLoad`, full-vector — mind free-vs-full DOF indexing: `computeReactionForce` works on full-length vectors, verify before wiring). Populate `reactionBalance[i].relativeImbalance` with the true `relativeError`, and add an additive field `solveRelativeResidual` carrying what the old field actually contained (the CG residual). Keep the entry shape otherwise identical.

Verification: new test — static-equivalent dynamic load at steady state has `relativeImbalance` small (<1e-6); and a test asserting `solveRelativeResidual` exists and differs in meaning (documented in the test name).

### Step 2 — Derive top-level convergence honestly

Replace the hardcoded `relativeResidual: 0` (line 160) with the max `relativeResidual` over all recorded step solves, and `converged: true` (line 164) with a value derived from the step results (all CG solves returned ok — which is guaranteed today by early-return, so compute it as `true` via derivation, not literal). Frame 0's zeroed convergence entry (line 118) is legitimate (no solve at t₀) — add the one-line comment saying so.

### Step 3 — CG: recompute the true residual and fix the denominator

In `sparse.ts` `solveConjugateGradient`:

1. Before returning (success or `cg-not-converged`), recompute `r_true = rhs − A·x` (one extra `csrMatVec`) and report `residualNorm`/`relativeResidual` from it.
2. Change the denominator: `rhsNorm = norm(rhs)`; when `norm(rhs) === 0` keep the existing early-return path (zero rhs → zero solution). Remove the `max(…, 1)` clamp so the criterion is genuinely relative. **This can change iteration counts** for systems with ‖b‖ < 1 (stricter, more iterations — correct behavior) and ‖b‖ > 1 is unchanged... verify that claim yourself: for ‖b‖>1 the old clamp already used ‖b‖, so only the small-load case tightens.
3. Apply the same de-clamping to the static residual helper and `computeReactionBalance`'s `reference` in `solver.ts` (~595-613): use the true norm with an explicit zero guard, not `max(…, 1)`.

Verification: all existing sparse/solver tests pass (they use loads with norms ≥ 1 — confirm; if any existing test's expected iteration count or residual changes, update it deliberately and say so in the report). New test: a scaled-down single-tet model (forces ~1e-6 N) converges to displacement matching the unscaled model × 1e-6 within relative 1e-8 — this fails against the old clamp with loose tolerance and passes with the fix (verify it actually discriminates by running it against unmodified code first).

### Step 4 — Static reaction-balance warning

After a static solve completes, if `reactionBalance.relativeError > 1e-3`, append a warning entry to the solve diagnostics (additive; look at how `CpuSolverDiagnostics` carries optional info — do not change the result `ok` status). Threshold as a named constant with a comment stating it is a sanity guard, not an accuracy claim.

### Step 5 — Honest damping

In `dynamic-mdof.ts` + `types.ts` (options type):

1. Add optional `rayleighTargetFrequenciesHz?: [number, number]`. When provided together with `dampingRatio > 0` (and explicit `rayleighAlpha/Beta` are absent), derive the classical two-frequency Rayleigh fit: `ω_i = 2π·f_i`, `α = 2ζ·ω₁·ω₂/(ω₁+ω₂)`, `β = 2ζ/(ω₁+ω₂)`. Validate `0 < f₁ < f₂`, both finite.
2. When `dampingRatio > 0` and **no** targets and no explicit α/β: keep the legacy `10·ζ / 1e-4·ζ` mapping unchanged (compatibility), but append a diagnostic warning stating: the effective damping ratio is `ζ·(5/ω + 5e-5·ω)`, it equals the requested ratio only near 0.8 Hz and 3.2 kHz, and `rayleighTargetFrequenciesHz` should be supplied. Record the anchor numbers in the diagnostic, not just prose.
3. Document all of this (formula, units of α [1/s] and β [s], legacy behavior) in `docs/validation/core.md`'s dynamic section.

Verification: unit test for the two-frequency fit — with targets `[f, f]`-adjacent (e.g. `[10, 20]` Hz) assert α and β against hand-computed values (compute them yourself in the test comment); test that the legacy path emits the warning; test that explicit `rayleighAlpha/Beta` still win over everything.

### Step 6 — Cloud pass-through check

`services/opencae-core-cloud/src/server.ts` `boundedSolverSettings` spreads `...input` (line 586-591), so `rayleighTargetFrequenciesHz` flows through automatically — verify nothing strips it, and confirm the field is validated (finite, ordered) solver-side since cloud clients are untrusted. No server code change expected; if one proves necessary, it is in scope but minimal.

## Hard boundaries

- **In scope:** `packages/solver-cpu/src/{dynamic-mdof.ts,sparse.ts,solver.ts,types.ts,index.ts}`, `docs/validation/core.md`, solver-cpu tests; a verification-only look at `server.ts`.
- **Out of scope:** Newmark integrator math (verified correct — do not "improve" it), lumped-mass assembly, the mass floor (plan 006 documents it), result field assembly (`results.ts`), eigenvalue/modal analysis (do NOT add a frequency estimator — targets come from the user), preview SDOF solver.
- Renaming existing diagnostic fields is forbidden; additive fields + corrected values only, except `relativeImbalance`'s **value** which this plan exists to fix.

## Done criteria (machine-checkable)

1. `grep -n "converged: true" packages/solver-cpu/src/dynamic-mdof.ts` → no literal hardcode (derived value).
2. `grep -n "relativeImbalance: entry.relativeResidual" packages/solver-cpu/src/dynamic-mdof.ts` → gone.
3. `grep -n "Math.max(norm(rhs), 1)" packages/solver-cpu/src/sparse.ts` → gone.
4. `pnpm build && pnpm test:only` green, including plan 003's `cross-solver-invariants.test.ts` unmodified.
5. New tests from Steps 1, 3, 5 present and passing (≥5 new tests).
6. The small-load discrimination test (Step 3) was demonstrated to fail against unmodified code (state this in your report).

## Test plan

Inline in steps. The discrimination test in Step 3 is mandatory — a "fix" whose test passes on the old code proves nothing.

## Maintenance notes

- If a future modal/eigen solve lands, auto-deriving Rayleigh targets from the first modes should replace the legacy fallback entirely; the warning text should then be retired.
- Anything consuming `reactionBalance` downstream (cloud diagnostics passthrough, web app) gets more honest numbers, not a shape change — but grep consumers (`grep -rn "relativeImbalance" apps/ services/`) and confirm none hardcode expectations.

## Escape hatches

- If existing tests pin the current (mislabeled) `reactionBalance` values in ways that suggest an external consumer contract (e.g. cloud tests asserting exact values), STOP and report before changing semantics.
- If recomputing the true CG residual measurably regresses solve time on the bracket fixture (>5%), report the measurement and land the recompute behind the diagnostics path only.
- If `computeReactionForce`'s full-vs-reduced DOF indexing doesn't line up as assumed in Step 1, STOP and report with the actual signature rather than force-fitting.
