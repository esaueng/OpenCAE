# Plan 007: Replace Unbounded `Math.min/max(...spread)` Over Result-Field Arrays

Base commit: `d1556f2` (origin/main). Execute AFTER plan 006 so the file contents below match your checkout.
Status: TODO
Priority: 2
Category: correctness

## Problem

Several hot paths compute field extents by spreading whole result-field arrays into `Math.min()` / `Math.max()`. V8 rejects calls with more than ~65k arguments (`RangeError: Maximum call stack size exceeded`), so any result field with more values than that crashes the app instead of rendering. Result fields scale with surface-mesh node count: cloud Gmsh meshes at fine/ultra presets and uploaded-CAD solves (the product's stated direction) will cross this threshold.

This is a known bug class in this codebase — it already crashed once and was fixed in `stabilizeDynamicFieldRanges`, and the repo documents the convention in a comment at `libs/opencae-core-adapter/src/index.ts:1432`: "beyond the V8 argument limit for Math.max(...values)". The sites below are the remaining unguarded instances. One of them additionally produces `Infinity`/`-Infinity` (and downstream `NaN` colors) on empty input.

## Current Evidence (verify each against your checkout before editing)

Field-scale sites (values arrays sized by surface nodes or faces — the ones that matter):

`apps/opencae-web/src/lib/api.ts:353-354` — inside `withDerivedSafetyFactorSurfaceField`, which runs on EVERY `getResults()` response (called at api.ts:321). `values` has one entry per surface-mesh node:

```ts
const finiteValues = values.filter(Number.isFinite);
if (!finiteValues.length) return results;
return {
  ...
      min: Math.min(...finiteValues),
      max: Math.max(...finiteValues),
```

`apps/opencae-web/src/resultFields.ts:1012-1013` — per-frame derived safety-factor fields for dynamic playback; `values` has one entry per surface node, and this runs once per frame:

```ts
const values = stressField.values.map((stress) => clampSafetyFactor(yieldMpa / Math.max(Math.abs(stress), 1e-9)));
derived.push({
  ...
  min: Math.min(...values),
  max: Math.max(...values),
```

`apps/opencae-web/src/resultFields.ts:666-667` — inside `resultSamplesForFaces`; `mapped.values` has one entry per display face. Additionally, when `field` is undefined AND `faces` is empty, `Math.min(...[])` = `Infinity` and `Math.max(...[])` = `-Infinity`, which flow into `normalizeValueForRender(value, Infinity, -Infinity)` and produce `NaN` normalized colors:

```ts
const min = Number.isFinite(field?.min) ? Number(field?.min) : Math.min(...mapped.values);
const max = Number.isFinite(field?.max) ? Number(field?.max) : Math.max(...mapped.values);
```

`apps/opencae-web/src/components/CadViewer.tsx:2576-2577` — fallback path when a source field lacks finite min/max; `finiteValues` is node-scale:

```ts
    min: Number.isFinite(source.min) ? source.min : Math.min(...finiteValues),
    max: Number.isFinite(source.max) ? source.max : Math.max(...finiteValues),
```

`services/opencae-core-cloud/src/index.ts:302-303` and `319-320` — container result assembly; guarded for emptiness but NOT for size (`finiteValues` is solver-mesh node-scale, exactly where counts grow fastest):

```ts
      min: finiteValues.length ? Math.min(...finiteValues) : 0,
      max: finiteValues.length ? Math.max(...finiteValues) : 0,
```

`libs/opencae-core-adapter/src/index.ts:779` — `Math.max(...frames.map(...), 0)` over transient frames. NOTE: plan 006's merge should already have replaced this with the loop from commit `4373faf`; if the loop is present, skip this site.

Frame/sample-bounded but same pattern, normalize mechanically while there (low risk):

- `services/opencae-solver-service/src/beamDemoSolver.ts:148-149, 175, 445-446` (demo-solver arrays)
- `libs/opencae-core-adapter/src/index.ts:1314, 1324` (`Math.min(...centers.map(...))` — bounded by selected-face center count; convert if the diff stays local to those expressions)

Explicitly OUT of scope (bounded, 1–3 element arrays; converting them is churn): `libs/opencae-core-adapter/src/index.ts:1172, 1249`, `apps/opencae-web/src/snapping/geometryQuery.ts:93-94`, `apps/opencae-web/src/components/RightPanel.tsx:1786`.

## Desired Behavior

- No result-field-scale array is ever spread into `Math.min`/`Math.max`.
- Empty inputs yield an explicit, finite outcome (return early / null extent), never `±Infinity` flowing into color normalization.
- The repo convention is the plain loop already used post-fix in the adapter (see the comment at `libs/opencae-core-adapter/src/index.ts:1428-1432`) — match it.

## Implementation Steps

1. In `apps/opencae-web/src/resultFields.ts`, add a small helper near the top (module-private; the web app and services do not share a utility package, so duplicate the helper per package rather than inventing a new shared lib):

```ts
function finiteExtent(values: ArrayLike<number>): { min: number; max: number } | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return min <= max ? { min, max } : null;
}
```

2. Replace the two `resultFields.ts` sites with the helper. At 666-667, when the extent is null (no field and no faces), fall back to the mode's neutral range so `normalizeValueForRender` receives finite bounds — mirror whatever `neutralValue(mode)` implies (read that function first; if there is no natural neutral range, use `{min: 0, max: 0}` which the existing `normalizeValueForRender` must already tolerate — check it does, and if not, guard at the call sites at ~line 672).
3. Apply the same loop-based replacement in `apps/opencae-web/src/lib/api.ts:353-354` and `apps/opencae-web/src/components/CadViewer.tsx:2576-2577` (each file gets its own copy of the helper or an inline loop — match the file's local style; CadViewer already contains many module-level helpers).
4. Same for `services/opencae-core-cloud/src/index.ts:302-303, 319-320` (keep the `: 0` empty fallback semantics identical) and the beam-demo/adapter bounded sites listed above.
5. Check `libs/opencae-core-adapter/src/index.ts:779`: if plan 006 already delivered the loop version, do nothing; otherwise convert.
6. Tests (vitest; colocate with the files under test, matching the repo's `foo.test.ts` convention — e.g. follow the style of `apps/opencae-web/src/resultFields.test.ts`):
   - `withDerivedSafetyFactorSurfaceField` with a stress field of 200,000 values and a matching surface mesh → returns a derived field with correct finite min/max, does not throw.
   - The `resultFields.ts` derived-frame path with 200,000-value frames → same.
   - `resultSamplesForFaces([], fields-without-match, mode)` → returns `[]` or samples with finite normalized values; nothing is `NaN`/`±Infinity`.
   - Container path: extend `services/opencae-core-cloud/src/index.test.ts` with a 200,000-value field case if the module's test harness allows constructing one cheaply; if not, cover the extracted helper directly.

## Verification Gates

```sh
pnpm typecheck
pnpm test
```

Expected: exit 0, all tests green, including the new large-array cases (which fail with `RangeError` before the fix — verify at least the api.ts case red-before/green-after by writing the test first).

## Done Criteria

- `grep -rn "Math\.min(\.\.\.\|Math\.max(\.\.\." apps libs services --include="*.ts" --include="*.tsx" | grep -v "\.test\."` returns only the explicitly out-of-scope bounded sites listed above (or fewer).
- New large-array and empty-input tests pass.
- No behavior change for small inputs: existing suite stays green with unchanged expectations.

## Out Of Scope

- The sibling `../opencae-core` repo (its solver emits fields with its own extent logic) — note any spread patterns you happen to see there in the PR body, but do not edit.
- Rewriting how min/max are consumed (legend scaling, normalization semantics) — only how they are computed.
- No new lint rules or source-text guard tests (plan 005 is removing that pattern).

## Maintenance Note

Any new result-field producer must use loop-based extents. The adapter comment at index.ts:1428-1432 is the canonical statement of the convention; point reviewers there.

## Escape Hatches

- If a cited line number doesn't contain the shown code, re-locate by searching the code excerpt text; if the surrounding logic has materially changed, STOP and report instead of guessing.
- If `normalizeValueForRender` cannot tolerate a zero-width range, report that separately rather than redesigning normalization inside this plan.
