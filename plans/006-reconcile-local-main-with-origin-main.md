# Plan 006: Reconcile Local `main` With `origin/main`, Preserving The Core-Adapter Review Fixes

Base commits: local `main` = `4373faf`, `origin/main` = `d1556f2`
Status: TODO
Priority: 1 (do this before every other 006+ plan — they are written against `origin/main` content)
Category: repo state / correctness

## Problem

The checkout at this repository's local `main` is a divergent, stale line:

- `git rev-list --left-right --count main...origin/main` → `1  34`.
- The 34 upstream-only commits include merged PRs #24–#27: the solver-accuracy lineage, the WCAG 2.1 AA accessibility pass (`apps/opencae-web/src/hooks/useFocusTrap.ts` etc.), the transient-deformation render guards + solver-space coordinate reconciliation (`solverSpaceResultCoordinateTransform` in `CadViewer.tsx`), the nodal stress-gradient recovery (`recoverSurfaceNodeScalarField`), CI (`.github/workflows/ci.yml`), the `plans/` directory, the API `security.ts` module, `libs/opencae-step` (STEP writer + parametric parts), and `ParametricPartBuilder`.
- Production (cae.esau.app) deploys from `origin/main` (Cloudflare Git integration for the web app; container runner 0.1.5 is live — verified via `https://cae.esau.app/api/cloud-core/health` on 2026-07-01, which reported `containerRunnerVersion: "0.1.5"`).
- The single local-only commit `4373faf` ("Address Tet10 local-solve review findings in opencae-core-adapter") contains real fixes that production does NOT have.

So: this checkout is missing a month of production fixes, and production is missing the local review fixes. Both directions matter.

## What `4373faf` Contains (must survive the merge)

From its commit message and code (verify with `git show 4373faf`). All changes are confined to `libs/opencae-core-adapter/src/index.ts` and `libs/opencae-core-adapter/src/index.test.ts`:

1. Guard the in-browser DOF budget for **dynamic** solves — the MDOF solver ignores `maxDofs`, so oversized meshes must fail fast instead of hanging the worker thread. (Local file has the comment "The dynamic MDOF solver does not enforce maxDofs itself, so guard the in-browser DOF budget here for both paths" near line 256.)
2. Union **all** selected face normals when mapping fixed/load selections to mesh nodes (was first-normal-only, silently dropping multi-face selections).
3. Distinct coarse/medium/fine/ultra local mesh presets (`{2,3,4,5}`; coarse == medium before).
4. Loop-based `peakLoadScale` instead of `Math.max(...frames.map(...))` (V8 argument-limit safe). Local lines ~735–739.
5. Explicit cloud structured-block node budget instead of inheriting the local preview budget.
6. Shared `facePlaneForNormal` between local node and cloud facet face-mapping (local line ~1163).
7. Deletions: vestigial `meshCellsForPreset` / `maxDofsForMeshPreset`, dead `vectorMagnitudes`, the always-Tet10 `elementType` discriminator.
8. Hoisted render bounds; element centroids precomputed once across dynamic frames.

## What `origin/main` Changed In The Same Files (must also survive)

`git diff --stat 5da43e0 origin/main -- libs/opencae-core-adapter/` → `index.ts` +138/−13, `index.test.ts` +243 lines. Notable upstream differences observed:

- Upstream `localSolveMaxDofs(study, coreModel)` takes two arguments; local takes one (`localSolveMaxDofs(coreModel)`). The signatures must be reconciled semantically, not textually — upstream made the budget study-aware; local added the dynamic-path guard. Both behaviors should exist after the merge.
- Upstream still has `meshCellsForPreset` (index.ts:1218) and `maxDofsForMeshPreset` (index.ts:1267) which local deleted — check for upstream callers before keeping the deletion.
- Upstream still has the spread-based `peakLoadScale` (index.ts:779) — prefer local's loop.
- Upstream added ~243 lines of adapter tests. All of them must pass after the merge (they encode upstream's intended behavior).

## Merge-Base

`git merge-base main origin/main` = `5da43e0`. The conflict surface is exactly the two adapter files; everything else is fast-forward content from origin.

## Implementation Steps

Work on a new branch. Never commit directly to `main`; deliver a PR.

1. Preconditions (STOP if any fails — see Escape Hatches):
   - `git -C /path/to/repo status --porcelain` must be empty. `libs/opencae-core-adapter/src/index.ts` is historically an actively-edited working-tree WIP file held open in the maintainer's editor; if it (or anything) is dirty, stop and report rather than stashing.
   - `git fetch origin` and re-check `git rev-list --left-right --count main...origin/main`. If the counts are no longer `1 N` (e.g. the maintainer already synced, or pushed more local commits), stop and report the new state.
2. `git switch -c sync/reconcile-origin-main main`
3. `git merge origin/main`
   - Expected conflicts: ONLY `libs/opencae-core-adapter/src/index.ts` and `libs/opencae-core-adapter/src/index.test.ts`. If any other file conflicts, stop and report (see Escape Hatches).
4. Resolve the two files semantically:
   - Start from the upstream (origin) version as the base structure, then re-apply the eight local behaviors listed above.
   - Keep upstream's study-aware `localSolveMaxDofs(study, coreModel)` signature and add local's dynamic-path enforcement into it (comment from local file explains why).
   - Keep both test suites: upstream's new cases and local's cases. Duplicated coverage is fine; deleted coverage is not.
   - For the vestigial deletions (item 7): grep the whole repo for callers first (`meshCellsForPreset`, `maxDofsForMeshPreset`, `vectorMagnitudes`). Keep a function if upstream added callers; otherwise keep the deletion.
5. Build the sibling core packages if not already built (tests resolve `@opencae/core` from `../opencae-core`):
   - The sibling must be at the commit pinned in `services/opencae-core-cloud/OPENCAE_CORE_REF`. Use plain `git -C ../opencae-core fetch && git -C ../opencae-core checkout <pinned-sha>` followed by `pnpm install` and `pnpm --filter @opencae/core build && pnpm --filter @opencae/examples build && pnpm --filter @opencae/solver-cpu build && pnpm --filter @opencae/solver-wasm build && pnpm --filter @opencae/solver-webgpu build && pnpm --filter @opencae/viewer build` from this repo.
6. Verify (all from the repo root):
   - `pnpm --filter @opencae/core-adapter test` (if no such script exists, `pnpm vitest run libs/opencae-core-adapter`) — expected: green, including upstream's ~243 new test lines and local's tests.
   - `pnpm typecheck` — expected: exit 0 (the script exists after the merge; origin added it).
   - `pnpm test` — expected: green (origin/main's suite was ~516 tests passing as of PR #27).
   - `pnpm verify:cloudflare-config && pnpm verify:runner-version` — expected: both pass (runner 0.1.5 pins are consistent on both lines).
7. Grep-confirm the local behaviors survived:
   - `grep -n "dynamic MDOF solver does not enforce maxDofs" libs/opencae-core-adapter/src/index.ts` → 1 hit
   - `grep -n "facePlaneForNormal" libs/opencae-core-adapter/src/index.ts` → definition + ≥2 call sites
   - `grep -n "Math.max(\.\.\..*frames" libs/opencae-core-adapter/src/index.ts` → 0 hits (loop version kept)
8. Open a PR from `sync/reconcile-origin-main` to `main` with a body that lists the eight preserved behaviors and links this plan.

## Done Criteria

- `git merge-base --is-ancestor origin/main sync/reconcile-origin-main` exits 0.
- `git merge-base --is-ancestor 4373faf sync/reconcile-origin-main` exits 0.
- Step 6 commands all pass; step 7 greps match.
- No files outside `libs/opencae-core-adapter/` were hand-edited during conflict resolution.

## Out Of Scope

- Do not modify solver math, mesh presets, or budgets beyond reconciling the two lines' existing behavior.
- Do not touch `services/opencae-core-cloud/OPENCAE_CORE_REF`, `RUNNER_VERSION`, wrangler configs, or deploy scripts.
- Do not push to `main` or deploy. The PR is the deliverable.

## Maintenance Note

After this lands, local `main` gains CI, `plans/`, and the `typecheck` script — subsequent plans (007–010) assume those exist. The adapter file remains a frequent WIP surface; future automated edits should treat it as owned by the maintainer and scope diffs tightly.

## Escape Hatches

- Working tree dirty at start → STOP and report the dirty paths (especially `libs/opencae-core-adapter/src/index.ts`, which may hold unsaved solver work).
- Conflicts outside the two adapter files → STOP and report the conflict list; the divergence analysis in this plan is then stale.
- Adapter tests from either side fail after a good-faith semantic resolution → STOP and report which behavior conflicts (e.g. upstream test expects `meshCellsForPreset` to exist); do not delete tests to make the merge pass.
- If `../opencae-core` is missing or cannot be checked out at the pinned SHA, STOP and report; do not run `scripts/ensure-opencae-core.mjs` blindly (it hard-fails on a dirty sibling and has been permission-sensitive in this environment) — prefer transparent git commands.
