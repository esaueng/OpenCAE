# Plan 001: Tighten Result Provenance Taxonomy

Base commit: `3a67db9`
Status: TODO
Priority: 1
Category: correctness / product truthfulness

## Problem

OpenCAE currently has a load-bearing run status split (`complete`, `complete_preview`, `complete_estimate`, `complete_benchmark`, `complete_legacy`), but the classifier still has a broad fallback that marks some non-Core-Cloud actual-mesh OpenCAE Core results as `production_fea`.

That is risky because the API persists run status from `runStatusForResultProvenance(...)`. A result from local `opencae-core-sparse-tet` or `opencae-core-mdof-tet` with `actual_volume_mesh` can become bare `complete`, even though the README and validation docs reserve production attribution for OpenCAE Core Cloud.

## Current Evidence

`libs/opencae-schema/src/index.ts`:

```ts
if (CoreCloudResultProvenanceSchema.safeParse(provenance).success) return "production_fea";
if (provenance.kind === "opencae_core_fea" && provenance.resultSource === "computed" && (provenance.meshSource === "actual_volume_mesh" || provenance.meshSource === "opencae_core_tet4" || provenance.meshSource === "structured_block_core")) {
  return "production_fea";
}
```

`apps/opencae-api/src/server.ts`:

```ts
const resultTier = classifyResultProvenance(solved.result.summary.provenance);
const resultStatus = runStatusForResultProvenance(solved.result.summary.provenance);
...
status: resultStatus,
resultTier,
```

`libs/opencae-core-adapter/src/index.ts`:

```ts
const OPENCAE_CORE_ACTUAL_STATIC_PROVENANCE: ResultProvenance = {
  kind: "opencae_core_fea",
  solver: "opencae-core-sparse-tet",
  meshSource: "actual_volume_mesh",
  resultSource: "computed",
  units: "m-N-s-Pa"
};
```

## Desired Behavior

Only results that satisfy `CoreCloudResultProvenanceSchema` should be `production_fea` and map to run status `complete`.

Actual-mesh local OpenCAE Core results should remain honest and first-class, but they need a non-production tier/status such as:

- `core_local_fea` tier
- `complete_local_fea` status
- UI/report label like `OpenCAE Core Local FEA`

Preview proxy results remain `core_preview` / `complete_preview`. Generated estimates remain `local_estimate` / `complete_estimate`.

## Implementation Steps

1. Update schema enums in `libs/opencae-schema/src/index.ts`.
   - Add `core_local_fea` to `ResultProvenanceTierSchema`.
   - Add `complete_local_fea` to `StudyRunStatusSchema`.
   - Add `complete_local_fea` to the terminal result status set.

2. Split classifier logic.
   - Keep `CoreCloudResultProvenanceSchema.safeParse(provenance).success` as the only path to `production_fea`.
   - Add a helper such as `isLocalOpenCaeCoreActualMeshProvenance(provenance)`.
   - That helper should require:
     - `kind === "opencae_core_fea"`
     - `resultSource === "computed"`
     - solver is `opencae-core-sparse-tet` or `opencae-core-mdof-tet`
     - mesh source is `actual_volume_mesh`, `opencae_core_tet4`, or `structured_block_core`
   - Return `core_local_fea` for that helper.

3. Update `runStatusForResultProvenance`.
   - `production_fea` -> `complete`
   - `core_local_fea` -> `complete_local_fea`
   - Preserve existing mappings for preview, estimates, benchmarks, and legacy.

4. Update display/report labels.
   - `apps/opencae-web/src/unitDisplay.ts`: add a label for `core_local_fea` that does not say production.
   - `services/opencae-post-service/src/index.ts`: add `resultTierLabel` and `nonProductionBanner` handling for `core_local_fea`. Recommended banner title: `LOCAL FEA`. Recommended message: `This result used local OpenCAE Core and is not OpenCAE Core Cloud production FEA.`
   - `apps/opencae-api/src/server.ts`: update `completeRunMessage` for the new tier.

5. Update tests.
   - In `libs/opencae-schema/src/schema.test.ts`, add cases proving:
     - `opencae-core-cloud` with valid Core Cloud provenance maps to `complete`.
     - `opencae-core-sparse-tet` with actual mesh maps to `complete_local_fea`.
     - `opencae-core-mdof-tet` with actual mesh maps to `complete_local_fea`.
     - A solver string other than the allowlisted local solvers with `opencae_core_fea` does not become production.
   - Add API coverage if an existing test can drive an actual-mesh local solve; otherwise add a narrow schema-level test and a report/unit-display test.

## Verification Gates

Run:

```sh
pnpm --filter @opencae/api exec tsc --noEmit
pnpm --filter @opencae/web exec tsc --noEmit
pnpm --filter @opencae/core-cloud exec tsc -p tsconfig.json --noEmit
pnpm test
```

Expected:

- Typecheck exits 0.
- Vitest exits 0.
- Tests for provenance status include the new local actual-FEA tier.

## Done Criteria

- No non-Core-Cloud provenance maps to `production_fea`.
- Existing preview and local-estimate labeling remains unchanged.
- Reports and web labels clearly distinguish Core Cloud production FEA from local actual-mesh Core FEA.
- Run status `complete` only means Core Cloud production provenance.

## Out Of Scope

- Do not change solver math or mesh generation.
- Do not remove local OpenCAE Core solves.
- Do not change Cloudflare deployment scripts.

## Escape Hatches

If maintainers explicitly want actual-mesh local Core solves to count as production, stop and update `README.md` and `docs/validation/README.md` first so the product contract matches the code. Do not silently keep the current classifier fallback.
