# Plan 010: Make The Cantilever Accuracy-Gate Fixture Schema-Valid (Remove The `as Study` Cast)

Base commit: `d1556f2` (origin/main). Execute AFTER plan 006.
Status: TODO
Priority: 5
Category: tests / solver-accuracy guardrails

## Problem

`apps/opencae-web/src/workers/localCantileverAccuracy.test.ts` is one of the repo's beam-theory regression gates — it checks the local solver against Timoshenko cantilever theory (tip deflection within tolerance). Its `cantileverStudy(type)` fixture builds ONE object shape for both `"static_stress"` and `"dynamic_structural"` studies and force-casts it with `as Study`. The object always carries STATIC solver settings:

```ts
solverSettings: { backend: "opencae_core_local", fidelity: "standard" },
```

The `Study` discriminated union requires the dynamic variant to carry dynamic solver settings (the `DynamicSolverSettings` shape with time-integration parameters). The cast silences exactly the two `tsc` errors this file used to produce on an earlier lineage — the union was never narrowed, it was just suppressed. Consequence: the dynamic accuracy benchmark (line 95, `cantileverStudy("dynamic_structural")`) runs against a study object that cannot exist in the real product, exercising whatever fallback/default path the adapter takes for missing dynamic settings instead of a representative dynamic study. The gate still asserts numbers, but it certifies a configuration users can't produce, and the cast will silently swallow future fixture drift (wrong field names, missing new required fields).

## Current Evidence

`apps/opencae-web/src/workers/localCantileverAccuracy.test.ts:29-68` (abridged):

```ts
function cantileverStudy(type: "static_stress" | "dynamic_structural"): Study {
  return {
    id: `study-${type}`,
    ...
    type,
    ...
    meshSettings: { preset: "medium", status: "complete", meshRef: "project-1/mesh/mesh-summary.json" },
    solverSettings: { backend: "opencae_core_local", fidelity: "standard" },
    validation: [],
    runs: []
  } as Study;
}
```

Line 95:

```ts
const outcome = trySolveOpenCaeCoreStudy({ study: cantileverStudy("dynamic_structural"), runId: "run-bench-dyn", displayModel });
```

## Desired Behavior

- The fixture constructs schema-valid `Study` objects per variant with NO `as Study` cast — TypeScript narrows the union naturally.
- The dynamic variant carries realistic dynamic solver settings equivalent to what the app actually produces (so the accuracy gate certifies a reachable configuration).
- Fixture invalidity fails loudly: parse the built object with the zod `StudySchema` inside the fixture (or a `beforeAll`), so schema drift breaks the test with a zod error instead of type-casting past it.

## Implementation Steps

1. Read the authoritative shapes first:
   - `libs/opencae-schema/src/index.ts` — find `StudySchema` and the static/dynamic `solverSettings` variants (search for `DynamicSolverSettings` / the discriminated union on `type`).
   - Find a REAL dynamic study example to copy defaults from: search `libs/opencae-db/src/sampleData.ts` for a `dynamic_structural` study (the seeded samples include dynamic variants) and/or how the web app constructs dynamic solver settings (search `apps/opencae-web/src` for `dynamic_structural` study creation). Use those values — do not invent time-step numbers.
2. Rewrite the fixture with a conditional, properly narrowed return:

```ts
function cantileverStudy(type: "static_stress" | "dynamic_structural"): Study {
  const base = { /* shared fields exactly as today, minus type/solverSettings */ };
  const study: Study = type === "static_stress"
    ? { ...base, type, solverSettings: { backend: "opencae_core_local", fidelity: "standard" } }
    : { ...base, type, solverSettings: { /* valid dynamic settings copied from the sample data */ } };
  return StudySchema.parse(study);
}
```

   Adjust to the real schema field names; the structure above is illustrative. If `StudySchema.parse` strips or transforms fields in a way the test depends on, use `StudySchema.parse` as an assertion (`StudySchema.parse(study)` then `return study`).
3. Remove the `as Study` cast entirely.
4. Run the accuracy tests and compare numbers:

```sh
pnpm vitest run apps/opencae-web/src/workers/localCantileverAccuracy.test.ts
```

   - If all assertions pass with UNCHANGED tolerances: done.
   - If the dynamic benchmark's numbers shift because real dynamic settings now drive the solve: STOP. Do not loosen tolerances or edit expected values. Report the before/after numbers — the maintainer must adjudicate whether the previous gate was certifying defaults or the new configuration is the right one to pin. (See Escape Hatches.)
5. `pnpm --filter @opencae/web exec tsc --noEmit` — must be clean WITHOUT the cast. If it reports errors in this file, the fixture is still schema-invalid; fix the fixture, never re-add a cast.

## Verification Gates

```sh
pnpm --filter @opencae/web exec tsc --noEmit
pnpm vitest run apps/opencae-web/src/workers/localCantileverAccuracy.test.ts
pnpm test
```

Expected: all exit 0; `grep -n "as Study" apps/opencae-web/src/workers/localCantileverAccuracy.test.ts` → no matches.

## Done Criteria

- No `as Study` (or any `as` cast on the fixture) remains in the file.
- The fixture round-trips `StudySchema.parse` at test time.
- Accuracy assertions pass with unchanged tolerances (or the run stopped per the escape hatch).
- No changes outside this test file.

## Out Of Scope

- Solver code (`libs/opencae-core-adapter`, sibling repo) — this plan touches ONE test file.
- The tolerances/physics of the benchmark (Timoshenko comparison values).
- Other fixtures using casts elsewhere (note them in the PR body if spotted; don't fix here).

## Maintenance Note

This file is a release gate for solver accuracy: treat any future edit that adds a type cast to its fixtures as a red flag in review — casts here have already hidden an invalid dynamic configuration once.

## Escape Hatches

- Dynamic benchmark numbers change after using valid dynamic settings → STOP and report before/after values; do not adjust tolerances.
- No valid dynamic-settings exemplar exists in sample data or app code (i.e. you cannot find real values to copy) → STOP and report; inventing time-integration parameters would make the gate certify made-up physics.
- `StudySchema` turns out not to be exported or is named differently → locate the schema actually used to validate studies (search `libs/opencae-schema` for the zod object with a `solverSettings` discriminant) and use that; if none exists, STOP and report.
