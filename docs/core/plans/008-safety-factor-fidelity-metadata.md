# 008 — Honest strength reporting: fidelity metadata on safety factors and max stress

- **Status:** TODO
- **Written against source commit:** `292a6eb` (branch `improvement-plans` at `2fec8c0` adds only `plans/`). Re-verify excerpts if source changed; on mismatch STOP and report drift.
- **Category:** engineering-validity (results interpretation / safety margin)
- **Effort:** S–M
- **Risk of change:** low–medium (additive metadata + docs; no numerical changes)

## Why this matters

The solver's primary engineering outputs — `summary.maxStress` and per-element / minimum **safety factors** — are computed from **raw constant-strain Tet4 element von Mises stress** on meshes that have had **no convergence verification**. First-order tets are known to underestimate stress at concentrations on coarse meshes (the repo's own cantilever benchmark documents Tet4 stress reaching only a fraction of beam theory on a coarse mesh). That bias makes the reported safety factor **anti-conservative**: the structure looks safer than it is. Today nothing in the result payload, docs, or web UI carries any caveat — a cloud user at `cae.esau.app` sees "safety factor 2.5" as a bare number.

This plan does **not** change how stress or SF are computed (the raw-element basis is a documented contract — docs/validation/core.md: "summary.maxStress and safety factor calculations stay tied to raw element von Mises values"). It makes the result **say what it is**: which stress basis, which fidelity level, and what that means. It also fixes a silent-omission case: models whose materials lack `yieldStrength` simply produce no safety-factor field, with no note.

Advisory boundary (must survive into the docs text): these caveats are engineering-communication improvements, not a validation program. Results from unconverged meshes remain unsuitable for safety-critical decisions without professional engineering review — the docs wording in Step 3 must state this.

## Current state (verified excerpts)

Safety factor — `packages/solver-cpu/src/results.ts:337-350`:

```ts
export function computeSafetyFactor(model: NormalizedOpenCAEModel, vonMises: Float64Array): Float64Array {
  ...
  values[element] = yieldStrength > 0 && vonMises[element] > 0 ? yieldStrength / vonMises[element] : 0;
```

Silent omission when yield is missing — `results.ts:352-354`:

```ts
function hasYieldStrength(model: NormalizedOpenCAEModel): boolean {
  return model.materials.some((material) => (material.yieldStrength ?? 0) > 0);
}
```

Documented stress split (docs/validation/core.md "Result Surface Fields"): plot field is volume-weighted nodal recovery (`visualizationSource: "volume_weighted_nodal_recovery"`), engineering values stay `engineeringSource: "raw_element_von_mises"` — the vocabulary for Step 1 already exists; reuse it.

Dynamic per-frame SF and `minSafetyFactor`: `packages/solver-cpu/src/dynamic-mdof.ts:151-152, 183`.

The recovered-nodal von Mises field is already computed for every solve (static: `packages/solver-cpu/src/results.ts:41`; dynamic frames: `results.ts:167`) — its max is available at no extra cost.

## Conventions to match

- `CoreSolveResult` summary/field shapes live in `packages/core/src/results.ts` and `packages/core/src/model-json.ts` types; `validateCoreResult` (`packages/core/src/results.ts`) validates result structure — **additive fields must not fail it** (check whether it rejects unknown keys before adding any; that check is your first task).
- Existing metadata style: lowercase snake/kebab string literals like `"raw_element_von_mises"`, `"volume_weighted_nodal_recovery"` — follow it.
- Cloud provenance stamping (`services/opencae-core-cloud/src/server.ts:377-407`) spreads summary/provenance — additive summary fields flow through untouched; verify.

## Steps

### Step 1 — Fidelity metadata on the summary

Add additive fields to the solve summary (exact insertion point: where `summary.maxStress` is built in `packages/solver-cpu/src/results.ts` — find `maxStress` assembly for both static and dynamic paths):

- `stressBasis: "raw_element_von_mises"` (reuse the existing string).
- `meshConvergence: "unverified"` (string literal union with room for a future `"verified"`; do not invent a verification mechanism here).
- `maxRecoveredNodalStress` + its units twin, taken from the already-computed recovered-nodal field (max over nodes; dynamic: max over frames). Document that raw-element and recovered-nodal values loosely bracket the discretization uncertainty on coarse meshes and neither is a converged value.

Same three concepts attached to the safety-factor summary value(s): wherever `minSafetyFactor` is surfaced, add `safetyFactorBasis: "raw_element_von_mises"`.

### Step 2 — Missing-yield-strength diagnostic

When `hasYieldStrength(model)` is false, append a diagnostic entry (follow the existing diagnostics list conventions in `results.ts` / `coreSolveDiagnostics`) with code `safety-factor-unavailable` and message "No material defines yieldStrength; safety factor fields are omitted." — so the absence is stated, not silent.

### Step 3 — Documentation

In `docs/validation/core.md` (Result Surface Fields / summary section) and `README.md` (brief note): explain `stressBasis`, `meshConvergence: "unverified"`, the anti-conservative direction of raw-element stress at concentrations on coarse meshes, and the sentence: "Safety factors computed from unconverged meshes are regression/inspection outputs, not design allowables; safety-critical use requires mesh-convergence evidence and professional engineering review."

### Step 4 — Boundary checks

- Run `validateCoreResult` against a result carrying the new fields (unit test) — must pass.
- Grep consumers for summary destructuring that might break on new keys: `grep -rn "summary\." apps/ packages/viewer/ services/ --include="*.ts" | grep -v test` — visually confirm additive safety.
- Cloud test: one assertion in `services/opencae-core-cloud/tests/server.test.ts` that a solve response summary carries `stressBasis` and `meshConvergence` (proves pass-through).

## Hard boundaries

- **In scope:** `packages/solver-cpu/src/results.ts` (metadata + diagnostic only), `packages/core/src/results.ts` / `model-json.ts` (type additions only, if the summary type lives there), `docs/validation/core.md`, `README.md`, tests in solver-cpu + cloud service.
- **Out of scope:** changing `summary.maxStress` semantics or value; changing `computeSafetyFactor` math; new stress-recovery methods; mesh-convergence automation (that is a roadmap item, not this plan); the web app UI; `validateCoreResult` rule changes beyond accepting additive fields (if it currently rejects unknown fields, STOP — see escape hatches).

## Done criteria (machine-checkable)

1. `grep -n "stressBasis" packages/solver-cpu/src/results.ts` hits for both static and dynamic paths.
2. `grep -n "safety-factor-unavailable" packages/solver-cpu/src/results.ts` hits.
3. `pnpm build && pnpm typecheck:only && pnpm test:only` green from root; new tests ≥3 (validateCoreResult acceptance, missing-yield diagnostic, cloud pass-through).
4. `docs/validation/core.md` contains the professional-review sentence from Step 3 verbatim or equivalent (`grep -n "professional engineering review" docs/validation/core.md`).

## Test plan

Inline in Steps 2 and 4. Fixture with no `yieldStrength` likely already exists in tests — reuse; otherwise derive one by cloning `singleTetStaticFixture` minus the property.

## Maintenance notes

- When a mesh-convergence study mechanism lands (roadmap), it should set `meshConvergence: "verified"` and this metadata becomes load-bearing — keep the union type, not a boolean.
- Plan 004 also edits `packages/solver-cpu/src/results.ts` (frame-loop geometry caching). Coordinate if both are in flight; the edits are in different functions but the same file.

## Escape hatches

- If `validateCoreResult` rejects unknown summary fields, STOP and report — loosening result validation is a contract decision for the owner, not something to slip into this plan.
- If the summary type is consumed by external packages beyond this repo (the web app at cae.esau.app is external), note in your report that additive fields assume tolerant consumers; do not attempt to verify the external app from here.
