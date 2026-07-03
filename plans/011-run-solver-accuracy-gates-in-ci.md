# Plan 011: Run The Solver Accuracy Gates In CI

Base commits: OpenCAE-Core (sibling) `08ca7a6`, open-cae `d1556f2` (origin/main)
Status: TODO
Priority: 1 of the engineering-validity plans (011–014)
Category: validation / reproducibility

## Problem

The project's only quantitative solver verification — `services/opencae-core-cloud/tests/cantilever-accuracy.test.ts` in the **OpenCAE-Core sibling repo** (tip deflection within ±3% of Timoshenko theory, peak von Mises within [0.9, 1.35]× the analytical outer-fiber stress, reaction within ±1 N, mesh-preset monotonicity, Tet4 locking floor, dynamic ramp end-state) — runs in **no CI anywhere**:

1. The sibling repo (github.com/esaueng/OpenCAE-Core) has **no `.github/` directory at all**. Its tests run only when someone manually runs `pnpm test` in that checkout.
2. open-cae's CI (`.github/workflows/ci.yml`) clones and **builds** the sibling's `packages/*` but never runs any sibling tests.
3. **Trap:** the open-cae root script `test:core-cloud` (`pnpm --filter @opencae/core-cloud test`) does NOT run the sibling's tests. `pnpm-workspace.yaml` includes only `../opencae-core/packages/*` — the sibling's `services/opencae-core-cloud` (where the accuracy tests live) is NOT a workspace member. Both repos have a package named `@opencae/core-cloud`; the filter resolves to open-cae's **mirror** at `services/opencae-core-cloud`, whose tests are service/contract tests, not the accuracy gates.

Consequence: a solver regression (element formulation, mass lumping, mesh generation, recovery) merges silently. The June accuracy review (`docs/validation/quality-accuracy-plan.md`, item M1) called for quantitative gates in CI; the gates now exist — they just never execute automatically.

## Current Evidence

- Sibling: `ls -a /path/to/opencae-core` → no `.github`. Root `package.json` scripts: `"test": "pnpm -r --if-present run test"`, `"typecheck": "pnpm -r --if-present run typecheck"`. `services/opencae-core-cloud/package.json`: `"test": "vitest run"`, `"typecheck": "tsc -p tsconfig.json --noEmit"`.
- open-cae `.github/workflows/ci.yml`: steps end at `pnpm typecheck` + `pnpm test` (open-cae's own tests); sibling packages built at lines ~28-36 but no sibling test step.
- open-cae `pnpm-workspace.yaml`:

```yaml
packages:
  - "../opencae-core/packages/*"
  - "packages/*"
  - "apps/*"
  - "libs/*"
  - "services/*"
  - "runners/*"
```

## Desired Behavior

- Part A: the sibling repo has its own CI running typecheck + full test suite (including the accuracy gates) on push/PR.
- Part B: open-cae's CI additionally executes the sibling's core-cloud tests against the **pinned** ref it builds, so a pin bump that breaks accuracy fails the open-cae PR, not production.

Each part is a separate PR in its own repo and delivers value alone.

## Implementation Steps

### Part A — CI for OpenCAE-Core (work in a worktree/branch of the SIBLING repo)

1. Read the sibling's test landscape first: `grep -rl "describe(" packages services --include="*.test.ts"` and each package.json's scripts. Check whether any test requires the `gmsh` binary (search `services/opencae-core-cloud/tests/` for gmsh invocation — `geometry-intake.test.ts` and `mesh.test.ts` are the candidates). Note which tests skip gracefully when gmsh is absent vs fail.
2. Create `.github/workflows/ci.yml` in the sibling repo:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - name: Install gmsh
        run: sudo apt-get update && sudo apt-get install -y --no-install-recommends gmsh && gmsh --version
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      - name: Build
        run: pnpm -r --if-present run build
      - name: Typecheck
        run: pnpm typecheck
      - name: Test
        run: pnpm test
```

   Adjust to the sibling's actual conventions (pnpm version pin from its `packageManager` field; drop the gmsh step ONLY if step 1 proved no test needs it). The accuracy tests use the structured-block mesher (no gmsh) but have `{ timeout: 120000 }` — keep default job timeout.
3. Run the suite locally in the sibling checkout ONCE to record the expected green baseline before pushing (`pnpm install && pnpm -r --if-present run build && pnpm typecheck && pnpm test`). If anything is red at `08ca7a6`/current main, STOP and report — do not ship a CI that is born red.
4. PR to OpenCAE-Core.

### Part B — open-cae CI runs the pinned sibling's accuracy tests (branch of open-cae; do AFTER plan 006 so ci.yml exists in your checkout)

5. In `.github/workflows/ci.yml`, after the existing "Build OpenCAE Core packages" step (the sibling checkout already exists in CI via `scripts/ensure-opencae-core.mjs`), add:

```yaml
      - name: Install OpenCAE Core workspace
        run: pnpm -C ../opencae-core install --frozen-lockfile
      - name: Solver accuracy gates (pinned OpenCAE Core)
        run: pnpm -C ../opencae-core/services/opencae-core-cloud test
```

   Do NOT use `pnpm --filter @opencae/core-cloud test` (resolves to the mirror — see Trap above). Verify whether `pnpm -C ../opencae-core install` conflicts with the parent workspace install (the sibling is its own pnpm workspace; `-C` scopes to it). If the sibling's core-cloud tests import built package output, ensure the earlier build step covers it or build in-place.
6. Verify locally: from the open-cae root, `pnpm -C ../opencae-core/services/opencae-core-cloud test` → the cantilever accuracy suite runs and passes (console lines like `Tet10 medium (default): ... ratio 0.99x`).
7. PR to open-cae. The PR's CI run must show the new step executing the accuracy tests.

## Verification Gates

- Part A: sibling PR's Actions run green with the Test step listing `cantilever-accuracy.test.ts` among executed files.
- Part B: open-cae PR's Actions run green with the "Solver accuracy gates" step showing the same.
- Negative check (optional, in a scratch branch of the sibling only): loosen one tolerance assertion, confirm CI fails, revert.

## Done Criteria

- Both workflows exist and passed on a real run.
- `git grep "filter @opencae/core-cloud" .github/` in open-cae → no hits (the mirror-vs-sibling trap not reintroduced).

## Out Of Scope

- Adding NEW benchmark cases (plans 012/013).
- Touching `scripts/ensure-opencae-core.mjs`, the frozen-install questions of plan 003, or deploy workflows.
- Renaming either `@opencae/core-cloud` package (worth considering someday; note it in the PR body, don't do it).

## Maintenance Note

When OPENCAE_CORE_REF advances, Part B automatically re-gates the new pin. The 120 s test timeouts bound the CI cost (~2–4 min). If sibling tests later need Docker/gmsh beyond apt's version, revisit alongside plan 013's gmsh pinning.

## Escape Hatches

- Sibling suite red at current main (step 3) → STOP, report the failures; fixing solver tests is not this plan.
- `pnpm -C ../opencae-core install` fights the parent workspace in CI (hoisting/lockfile errors) → STOP and report the exact error; propose running sibling tests in a separate job with its own checkout of the pinned SHA instead.
- If maintainers cannot grant Actions on the OpenCAE-Core repo, deliver Part B alone and say so.
