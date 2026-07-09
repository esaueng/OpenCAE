# 006 — Engineering unit conventions: document them and guard model inputs

- **Status:** TODO
- **Written against source commit:** `292a6eb` (working branch `improvement-plans` at `2fec8c0` only adds `plans/`; source files are identical). Run `git log --oneline -2` — if source files changed since, re-verify every excerpt before starting; on mismatch STOP and report drift.
- **Category:** engineering-validity (units / materials / loads)
- **Effort:** M
- **Risk of change:** low (docs + validation *warnings* only — no errors added, no solver behavior changed)

## Why this matters

The model schema declares one of two unit systems (`coordinateSystem.solverUnits`: `"m-N-s-Pa"` or `"mm-N-s-MPa"`), but **nowhere — code, schema, README, or docs — states what units density, gravity acceleration, yield strength, mass, or time must be in for each system**, and validation checks only sign/finiteness. Consistent mechanics in `mm-N-s-MPa` requires density in **tonne/mm³** (steel: `7.85e-9`), which is 9 orders of magnitude from the kg/m³ number (7850) every engineer knows. The failure modes are silent and enormous:

- density entered as kg/m³ in a mm model → mass, gravity loads, and all dynamic response wrong by ~1e9;
- gravity entered as `-9.81` in a mm model (needs `-9810` mm/s²) → gravity loads 1000× low;
- yieldStrength entered in Pa in a mm/MPa model → safety factors 1e6 too high (anti-conservative).

None of these produce an error today; the solve completes and returns plausible-looking numbers. Two related unitful magic constants are also undocumented: the dynamic mass floor `1e-12` (masks zero/near-zero masses silently) and the degenerate-volume tolerance `1e-14` (absolute, so its physical meaning shifts 1e9× between m³ and mm³).

Finally, pressure loads default their direction to the facet normal, whose sign comes from the facet's node winding — a convention that is not documented and not validated, so a wrongly-wound user-supplied facet silently flips a pressure load 180°.

## Current state (verified excerpts)

Density used as a bare scalar — `packages/core/src/loads.ts:261` (body gravity) and `packages/solver-cpu/src/dynamic-mdof.ts:391` (lumped mass):

```ts
const mass = material.density * volume;
const elementForce = scaleVector(load.acceleration, mass);
```
```ts
const elementMass = geometry.volume * density;
```

Mass floor — `packages/solver-cpu/src/dynamic-mdof.ts:93`:

```ts
for (let i = 0; i < free.length; i += 1) reducedMass[i] = Math.max(lumpedMass[free[i]], 1e-12);
```

Degenerate-volume tolerance — `packages/solver-cpu/src/geometry.ts:3,35`: `tolerance = 1e-14` absolute on signed volume.

Pressure direction defaults to winding-dependent normal — `packages/core/src/loads.ts:213-214`:

```ts
const direction = load.direction ?? geometry.normal;
const facetForce = scaleVector(direction, load.pressure * geometry.area);
```

Validation today: `packages/core/src/validation.ts` checks density/yieldStrength positivity and element volume > 0 — no unit plausibility, no orientation checks. `ValidationReport` already has both `errors` and `warnings` arrays (see `validateModelJson` in `packages/core/src/validation.ts`; the web app renders both — `apps/web/src/app.ts:163`), so warnings are an established, non-breaking channel.

Grep-verified: `grep -rn "tonne\|kg/m" docs/ README.md packages/core/src/` returns nothing.

## Conventions to match

- Docs live in `docs/validation/core.md` (single validation reference) and `README.md`; extend, don't create parallel doc trees.
- Validation issues are `{ code, message, path }` created via the `issue(...)` helper in `validation.ts`; warning codes are kebab-case. Follow existing code style exactly (look at an existing warning if present; if none exist yet, mirror the error style).
- Tests: `packages/core/tests/validation.test.ts` (679 lines) — match its arrange/assert style.
- TypeScript strict, ESM, result-object style. Never throw from validation.

## Steps

### Step 1 — Write the unit conventions reference

Add a "Units and Conventions" section to `docs/validation/core.md` (and a short pointer in `README.md`) with a per-system table:

| Quantity | `m-N-s-Pa` | `mm-N-s-MPa` |
|---|---|---|
| length | m | mm |
| force | N | N |
| time | s | s |
| stress, E, yieldStrength | Pa | MPa |
| density | kg/m³ | tonne/mm³ (= kg/m³ × 1e-12... **derive and verify the exact factor yourself**: 1 kg/m³ = 1e-12 tonne/mm³) |
| mass | kg | tonne |
| acceleration | m/s² | mm/s² (Earth gravity ≈ 9810) |

Include a worked steel example in both systems (E = 2.1e11 Pa / 2.1e5 MPa, density = 7850 kg/m³ / 7.85e-9 tonne/mm³, yield = 2.5e8 Pa / 250 MPa, g = 9.81 / 9810). Also document, in the same section:

- the dynamic mass floor `1e-12` (solver mass units) and when it engages;
- the degenerate-volume tolerance `1e-14` (solver volume units) and its unit-dependence;
- the pressure sign convention: positive `pressure` acts along the facet normal computed from the facet's node winding (right-hand rule); for boundary facets derived from volume connectivity the normal points outward; a user-supplied facet wound the other way flips the load.

Verify the derivations by dimensional analysis before writing them down; do not copy the table above blindly — if you derive a different factor, STOP and report the discrepancy.

### Step 2 — Density and gravity plausibility warnings

In `packages/core/src/validation.ts`, add **warnings** (never errors) keyed off the declared `solverUnits`:

- `implausible-density`: density outside `[1, 25000]` in kg/m³-equivalents — i.e. outside `[1, 25000]` for `m-N-s-Pa`, outside `[1e-12, 2.5e-8]` for `mm-N-s-MPa`. Message must state the expected unit and the common correct value for steel in that system.
- `implausible-gravity-acceleration`: only when a `bodyGravity` load is present; warn when the magnitude is outside `[0.01, 1000]` m/s²-equivalents (i.e. `[10, 1e6]` mm/s² for the mm system). Wide bounds on purpose — centrifugal and shock accelerations are legitimate; this only catches unit-system slips of 1e3+.

### Step 3 — Yield/modulus consistency warning

Add `implausible-yield-to-modulus-ratio`: warn when `yieldStrength / youngsModulus` (both must be in the same stress unit if entered consistently) is outside `[1e-5, 0.5]`. This is a **unit-mismatch detector**: yield in Pa against E in MPa (or vice versa) lands ~1e6 off the physical range (real materials: ~1e-3 to ~1e-2). Message must say exactly that ("yieldStrength and youngsModulus appear to be in different stress units").

Check the actual property name for Young's modulus in `packages/core/src/model-json.ts` before coding (do not guess; it may be `youngsModulus`, `e`, or similar).

### Step 4 — Pressure-facet orientation warning

For each pressure load **without an explicit `direction`**, and for each surface facet it references that can be matched to exactly one owning tet (all 3 facet nodes appear in one tet's 4 nodes): compute the facet normal from its stored winding and warn (`inward-facing-pressure-facet`) if the normal points **toward** the owning tet's centroid (dot(normal, centroid − facetCenter) > 0). Reuse the tet-face extraction helpers in `packages/core/src/topology.ts` — do not duplicate geometry code (this package already has a known `triangleGeometry` duplication; don't add a third copy).

Skip silently (no warning) when a facet matches zero or multiple tets. This is a heuristic guard, not a rejection.

### Step 5 — Mass-floor engagement diagnostic

In `packages/solver-cpu/src/dynamic-mdof.ts`, count DOFs where the `1e-12` floor actually replaced a smaller assembled mass (line 93) and, when the count is nonzero, add a diagnostic entry to `DynamicTet4CpuDiagnostics` (additive field, e.g. `flooredMassDofCount`) plus a human-readable note in the existing diagnostics flow. Do not change the floor value or behavior.

### Step 6 — Tests

In `packages/core/tests/validation.test.ts`: one test per new warning code — trigger it, assert the code appears in `report.warnings` (not `errors`) and `report.ok` stays `true`; plus one negative test each (plausible values produce no warning). In `packages/solver-cpu/tests/dynamic.test.ts`: one test that a normal fixture reports `flooredMassDofCount` of 0 (or absent).

## Hard boundaries

- **In scope:** `docs/validation/core.md`, `README.md` (pointer only), `packages/core/src/validation.ts` (warnings only), `packages/solver-cpu/src/dynamic-mdof.ts` (diagnostic count only), tests.
- **Out of scope:** any new validation **errors**; changing the mass floor, volume tolerance, load assembly, or solver math; `loads.ts`; auto-converting units (explicitly rejected — silent conversion is worse than silent trust); the cloud service.

## Done criteria (machine-checkable)

1. `grep -n "tonne/mm" docs/validation/core.md` hits (units table exists).
2. `grep -c "implausible-density\|implausible-gravity-acceleration\|implausible-yield-to-modulus-ratio\|inward-facing-pressure-facet" packages/core/src/validation.ts` ≥ 4.
3. `pnpm build && pnpm test:only` green from root; total test count strictly greater than the pre-change baseline (record it first).
4. All 220+ pre-existing tests untouched and passing — new warnings must not flip any existing fixture's `report.ok`. If any existing fixture triggers a new warning as an **error**, you implemented it in the wrong array — fix, don't adjust the fixture.

## Test plan

Covered in Step 6. Expected net-new tests: ≥9.

## Maintenance notes

- Any new load type or material property must get a row in the units table in the same PR.
- The plausibility bounds are heuristics; if users report false positives, widen bounds — never convert to errors without a schema version bump.
- The backlog item "degenerate-element policy unification" (plans/README.md) is the eventual owner of *changing* the epsilon/floor values; this plan only documents them.

## Escape hatches

- If a canonical fixture (e.g. `singleTetStaticFixture`) triggers a plausibility warning, STOP: either the fixture has a real unit inconsistency (report it — that's a finding) or your bounds/derivation are wrong. Do not "fix" the fixture.
- If facet→owning-tet association can't be built from existing `topology.ts` helpers without new geometry code, implement only the documentation half of Step 4 and report what helper was missing.
- If Young's modulus property naming differs across schema versions (0.1.0 vs 0.2.0 normalization), apply Step 3 post-normalization or skip 0.1.0 with a note — do not special-case guesswork.
