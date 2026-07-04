# Plan 008: Make CI Build The Web App And Enforce The Existing Bundle Budget

Base commit: `d1556f2` (origin/main). Execute AFTER plan 006 (this checkout only gains `.github/workflows/ci.yml` via that sync).
Status: TODO
Priority: 3
Category: DX / release integrity

## Problem

CI (`.github/workflows/ci.yml`) runs `pnpm typecheck` and `pnpm test` but never runs the production web build (`vite build`) or the bundle-budget checks. The `@opencae/web` build script is `tsc --noEmit && vite build`; CI's typecheck covers the `tsc` half only. Rollup/Vite build failures (chunking errors, asset resolution, import.meta issues) and bundle-budget regressions therefore surface for the first time during `pnpm deploy:cloudflare` — on the maintainer's machine or in Cloudflare Builds, after merge.

The repo already owns the guard rails; they're just not wired into CI:

- `scripts/check-web-bundle-budget.mjs` — pure static analysis of `apps/opencae-web/dist/`: computes gzip size of the initial JS module graph, fails over 175 KB (`INITIAL_JS_GZIP_BUDGET_BYTES = 175 * 1024`, line 7). Also exposed as the web package script `check:bundle`.
- `scripts/verify-web-performance.mjs` — asserts no heavy chunk (`WorkspaceApp|CadViewer|viewer-three|cad-import|occt`) is modulepreloaded and re-checks the same 175 KB budget; then continues into a spawned-process phase (it imports `spawn`) — see step 4 before using it in CI.

## Current Evidence

`.github/workflows/ci.yml` (full job order today): checkout → clone pinned sibling → pnpm setup → node 22 + pnpm cache → `pnpm install --frozen-lockfile` → build six `@opencae/*` core packages → `node scripts/verify-cloudflare-config.mjs` → `node scripts/verify-runner-version.mjs` → `pnpm typecheck` → `pnpm test`. No `vite build`, no budget check.

`apps/opencae-web/package.json`:

```json
"build": "tsc --noEmit && vite build",
"check:bundle": "node ../../scripts/check-web-bundle-budget.mjs",
```

Note: CI has already built the sibling core packages by the time tests run, so `pnpm --filter @opencae/web build` works in CI WITHOUT invoking `pnpm build:core` (whose unfrozen-install problem is plan 003's territory — do not touch it here).

## Implementation Steps

1. Append two steps to the `test` job in `.github/workflows/ci.yml`, after the existing `Test` step (keeping the current step style — plain `run:` entries with `name:`):

```yaml
      - name: Build web app
        run: pnpm --filter @opencae/web build

      - name: Enforce web bundle budget
        run: node scripts/check-web-bundle-budget.mjs
```

2. Match the workflow's existing formatting conventions exactly (2-space indent, `name:` capitalization as in current steps).
3. Do NOT add `pnpm build:core`, `pnpm verify:perf`, or any deploy dry-run — the core packages are already built earlier in the job, and `verify:perf` triggers `build:core`'s unfrozen install (plan 003).
4. OPTIONAL (only if it proves CI-safe): also run the modulepreload assertion. First read `scripts/verify-web-performance.mjs` end-to-end. If everything after the budget check spawns a preview server / browser measurement, do NOT add it to CI in this plan; instead note in the PR body that the preload assertion could be extracted into `check-web-bundle-budget.mjs` as a follow-up. If the script turns out to be fully headless and exits cleanly on a built `dist/`, you may add it as a third step.
5. Verify locally before pushing the branch:
   - `pnpm --filter @opencae/web build` (requires the sibling core packages built — same preparation as plan 006 step 5) → exit 0, `apps/opencae-web/dist/` populated.
   - `node scripts/check-web-bundle-budget.mjs` → exit 0 and prints nothing fatal (current bundle is under budget).
6. Open a PR. The PR's own CI run is the real verification: the two new steps must appear and pass.

## Verification Gates

```sh
pnpm --filter @opencae/web build
node scripts/check-web-bundle-budget.mjs
```

Expected: both exit 0 locally, and the PR's GitHub Actions run shows the new steps green.

## Done Criteria

- `.github/workflows/ci.yml` contains a step running `pnpm --filter @opencae/web build` and a step running `node scripts/check-web-bundle-budget.mjs`, both after typecheck/test.
- The PR's CI run passes with the new steps executed (visible in the Actions log).
- No other workflow steps were reordered, renamed, or removed.

## Out Of Scope

- `pnpm build:core` / frozen-install reproducibility (plan 003).
- Changing the 175 KB budget value or the chunking strategy in `apps/opencae-web/vite.config.ts`.
- Adding lint, deploy dry-runs, or caching changes to CI.

## Maintenance Note

When the budget is eventually raised or the initial-chunk strategy changes, `scripts/check-web-bundle-budget.mjs` and `scripts/verify-web-performance.mjs` both hardcode `175 * 1024` — change both or extract the constant. Watch CI duration: `vite build` adds ~tens of seconds; if the job grows past acceptable, split web build into a parallel job that reuses the pnpm cache.

## Escape Hatches

- If `pnpm --filter @opencae/web build` fails locally at HEAD for reasons unrelated to your change (e.g. sibling packages not built, or a pre-existing type error), STOP and report — do not "fix" application code to make CI green under this plan.
- If the current bundle is already OVER budget at HEAD (budget check fails with no changes), STOP and report the measured size; deciding whether to raise the budget or shrink the bundle is the maintainer's call.
