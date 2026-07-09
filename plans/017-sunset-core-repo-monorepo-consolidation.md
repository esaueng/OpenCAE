# Plan 017: Sunset OpenCAE-Core — Make open-cae A Fully Standalone Monorepo

Base state: open-cae `main` at 9140ad9 (post PR #34 + Tet10 elevation rescue); sibling OpenCAE-Core pinned at `bc6c305` via `OPENCAE_CORE_REF`.
Status: TODO
Priority: architecture track; do after the current plan-016 WIP lands, before further solver work widens the two-repo surface
Category: architecture / repo structure / build reproducibility / licensing

## Problem

open-cae is not a standalone repository. Its pnpm workspace reaches outside the
repo (`pnpm-workspace.yaml`: `"../opencae-core/packages/*"`), a root
`OPENCAE_CORE_REF` file pins a sibling git checkout, ~150 lines of bootstrap
tooling (`scripts/ensure-opencae-core.mjs`, `scripts/verify-core-ref-reachable.mjs`,
plus their tests) exist only to manage that sibling, `build:core` runs
`pnpm install --no-frozen-lockfile` because the lockfile cannot be stable when
half the workspace lives in another repo (plan 003's root cause), and CI's first
step is cloning the sibling.

The separation existed to deploy Core independently as the cloud solver runner.
That rationale is gone: commit `c0bb479` ("B4b: remove the OpenCAE Core Cloud
solve infrastructure") retired the cloud path, and Core is now consumed in
exactly one place — this repo's browser build. Meanwhile the split still costs:

- Every solver feature is a two-repo lockstep dance (Core commit → push →
  pin-bump commit here). Atomic cross-cutting changes are impossible.
- **The production pin does not point at Core's `main`.** `bc6c305` is the head
  of Core branch `feat/solver-progress-hooks` (5 commits ahead of
  `origin/main`, stacked on `fix/render-ready-results`). Core's `main` is not
  the source of truth for what ships; only the pin file knows.
- Core has **no CI at all** (advisor finding 11: solver accuracy gates run in
  no CI) and **no LICENSE file** (open-cae is Apache-2.0; Core is legally
  unlicensed).
- Known traps caused by the split: duplicate `@opencae/core-cloud` package
  names, duplicate `@opencae/web` names (Core's `apps/web` collides with
  `apps/opencae-web` — masked only because the workspace globs just
  `../opencae-core/packages/*`), workspace-excludes-sibling-services filter
  surprises, and the cross-repo RUNNER_VERSION toil (backlog).

## Desired Behavior

- A fresh `git clone` of open-cae + `pnpm install --frozen-lockfile` +
  `pnpm build && pnpm test && pnpm typecheck` succeeds with **no sibling
  checkout, no network fetch of a second repo, and no pin file**.
- Core's six packages live in this repo under `packages/*`, keep their
  `@opencae/*` names, and their tests/accuracy gates run in this repo's CI on
  every PR (delivers plan 011 Part A as a side effect).
- The OpenCAE-Core GitHub repo is archived read-only with a tombstone README.
- Every Core commit worth keeping (the pinned lineage, unmerged branches,
  unpushed local work) is either merged into the import point or explicitly
  written off in the PR description.
- `build:core` (or its successor) uses `--frozen-lockfile` — plan 003 closes.
- Apache-2.0 explicitly covers the imported packages.

## Inventory (verified 2026-07-09)

Coupling points in open-cae that must change:

| Artifact | Coupling |
| - | - |
| `pnpm-workspace.yaml` | `"../opencae-core/packages/*"` entry |
| `OPENCAE_CORE_REF` (repo root) | pin file, currently `bc6c305272bd2789634f5e4c9006e0eae21e116b` |
| `scripts/ensure-opencae-core.mjs` + `.test.mjs` | clone/update sibling |
| `scripts/verify-core-ref-reachable.mjs` + `.test.mjs` | deploy gate on pin pushability |
| `package.json` scripts | `ensure:core`, `build:core` (unfrozen install), `verify:core-ref`, and the `deploy:cloudflare*` chains that call them |
| `.github/workflows/ci.yml` | "Clone pinned OpenCAE Core sibling workspace" step + core package build step |
| `pnpm-lock.yaml` | importers resolving into `../opencae-core` |
| Consumers | `@opencae/core` ← web, core-adapter, solve-pipeline, mesh-intake; `@opencae/solver-cpu` ← core-adapter, solve-pipeline, mesh-intake |
| Docs | `README.md`, `docs/architecture/README.md`, `docs/local-development/README.md`, `docs/cloud-retirement.md`, `plans/README.md` recon summary |

Core repo contents to triage (`github.com/esaueng/OpenCAE-Core`, 11 commits, ~490 KiB pack):

| Item | Disposition |
| - | - |
| `packages/core` | import (schema, model types, elevateTet4MeshToTet10) |
| `packages/solver-cpu` | import (the production solver; deps: core, examples) |
| `packages/examples` | import (dep of solver-cpu and viewer) |
| `packages/solver-wasm`, `packages/solver-webgpu` | import (stubs today, but they are the plan-015/016 local-tier future) |
| `packages/viewer` | import (deps: core, examples, solver-cpu; unconsumed by open-cae today — keep, cheapest to carry) |
| `apps/web` (`@opencae/web`) | **drop** — name-collides with `apps/opencae-web`; it was Core's standalone dev harness |
| `services/opencae-core-cloud` (`@opencae/core-cloud`) | **drop** — retired cloud runner; also resolves the name-collision backlog item |
| `ARCHITECTURE.md`, `BENCHMARKS.md`, `ROADMAP.md`, `PROJECT_BRIEF.md`, `PLANS.md`, `AGENTS.md`, `docs/validation` | move to `docs/core/` (merge validation content into `docs/validation/` where it overlaps) |
| LICENSE | none exists — Apache-2.0 coverage added on import |
| CI | none exists — nothing to migrate |

Core branch state (verified against `origin` 2026-07-09):

- `feat/solver-progress-hooks` = `bc6c305` = **the production pin**, 5 ahead of
  `origin/main` (contains `fix/render-ready-results`'s 4 commits).
- `security/redact-secrets`: 1 unmerged commit — triage before archive.
- `audit-fixes`, `improvement-plans`, `fix/bracket-tet10-inverted-jacobian`,
  `solver-accuracy-0.1.5`: fully merged, nothing to rescue.
- Old checkout `~/claude/open-cae-core` (branch `improvement-plans`): has an
  **uncommitted** `plans/README.md` edit and **untracked** Core advisor plans
  006–009 (unit conventions, dynamic diagnostics, safety-factor metadata,
  cloud meshing guards). Rescue before deleting the checkout.
- Extra local clones of open-cae itself (`open-cae-dup`, `open-cae-gradient`,
  `open-cae-tierwork`) will go stale after the restructure; retire them.

## Implementation Steps

### Phase 0 — reconcile sources of truth (small PRs / pushes, both repos)

1. In open-cae: land or shelve the in-flight WIP (the plan-016 meshing changes
   on `docs/readme-copy-tighten`) and resolve the unmerged
   `sync/reconcile-origin-main` branch (plan 006). The consolidation PR must
   start from a clean, agreed `main`.
2. In Core: merge `feat/solver-progress-hooks` (`bc6c305`) into Core `main`, so
   `main` finally equals what production builds against. Fast-forward is
   expected to be clean since everything else is merged.
3. In Core: triage `security/redact-secrets` (1 commit) — merge or reject
   explicitly.
4. Rescue the old checkout: in `~/claude/open-cae-core`, commit the
   `plans/README.md` edit and plans 006–009 to `improvement-plans` and push —
   or, simpler, copy those four plan files into this repo's `plans/` as
   Core-lineage reference docs (`docs/core/plans/`). Do not let uncommitted
   work be the thing the archive destroys.
5. Record the final Core `main` SHA. That is the import point.

### Phase 1 — import (one PR together with Phase 2; they cannot be split)

6. Import Core at the recorded SHA into `packages/` via
   `git subtree add --prefix=packages-import <core-remote> main`, then move
   `packages-import/packages/*` up to `packages/{core,examples,solver-cpu,solver-wasm,solver-webgpu,viewer}`
   and `packages-import/{ARCHITECTURE,BENCHMARKS,ROADMAP,PROJECT_BRIEF,PLANS,AGENTS}.md`
   + `docs/validation` to `docs/core/`; delete `apps/web`,
   `services/opencae-core-cloud`, and Core's root `package.json` /
   `pnpm-workspace.yaml` / `pnpm-lock.yaml` / `tsconfig.base.json`. History is
   11 commits — subtree is cheap; the archived GitHub repo remains the deep
   history record regardless.
7. `pnpm-workspace.yaml` already contains `"packages/*"` — the only edit is
   deleting the `"../opencae-core/packages/*"` line.
8. Align toolchain versions: Core pins TypeScript 5.9.3 / Vite 6.4.2 vs the
   root's 5.7.3; standardize on the newer line at the root and remove
   per-package duplicates. Verify `tsconfig` inheritance — imported packages
   must extend this repo's `tsconfig.base.json`.
9. Add `"license": "Apache-2.0"` to each imported package.json; extend
   `THIRD_PARTY_NOTICES.md` if any imported package vendors third-party code.

### Phase 2 — decouple build, lockfile, CI (same PR)

10. Delete `OPENCAE_CORE_REF`, `scripts/ensure-opencae-core.mjs`,
    `scripts/ensure-opencae-core.test.mjs`, `scripts/verify-core-ref-reachable.mjs`,
    `scripts/verify-core-ref-reachable.test.mjs`.
11. `package.json`: remove `ensure:core` and `verify:core-ref`; rewrite
    `build:core` as a plain filtered build with **no install step**
    (`pnpm --filter @opencae/core build && …`), or fold it into `build` with
    `pnpm -r --sort`. Remove `verify:core-ref` from every `deploy:cloudflare*`
    chain. This closes plan 003.
12. Regenerate `pnpm-lock.yaml` once (`pnpm install`), review the importer diff
    (watch the `fast-uri: 3.1.2` override survives), and from then on every
    documented install path uses `--frozen-lockfile`.
13. `.github/workflows/ci.yml`: delete the sibling-clone step; keep the core
    package build step (now building in-repo paths); add
    `pnpm --filter "./packages/*" test` so the solver accuracy gates run on
    every PR (plan 011 Part A lands here for free).
14. Sweep the guard scripts: `scripts/cloud-retirement-guard.test.mjs`,
    `scripts/core-cloud-validation-docs.test.mjs`, and
    `scripts/verify-cloudflare-config.mjs` for assertions that reference the
    pin, the sibling path, or the deleted scripts; update expectations.
    Consider adding one new guard test: no file outside `docs/` and `plans/`
    may reference `../opencae-core` or `OPENCAE_CORE_REF`.

### Phase 3 — prove standalone (gates for the Phase 1+2 PR)

15. With the sibling temporarily renamed away (`mv ~/claude/opencae-core
    ~/claude/opencae-core.parked`):
    - `pnpm install --frozen-lockfile`
    - `pnpm build` (includes web production build)
    - `pnpm typecheck` — note the pre-existing `localCantileverAccuracy`
      failure is a known WIP condition, not a regression of this plan
    - `pnpm test`
    - `pnpm verify:cloudflare-config`
    - `pnpm deploy:cloudflare:dry-run`
16. CI green on the PR without the clone step.
17. `grep -rn "opencae-core\|OPENCAE_CORE" --exclude-dir=node_modules` returns
    only historical docs (`docs/cloud-retirement.md`, `plans/`, `docs/core/`).

### Phase 4 — docs (same PR or immediate follow-up)

18. Update `README.md`, `docs/architecture/README.md`,
    `docs/local-development/README.md` (setup no longer mentions a sibling
    clone), and the recon summary in `plans/README.md`.
19. `docs/cloud-retirement.md`: add the repo-consolidation coda — Core sunset
    date, final SHA, where each piece went.

### Phase 5 — archive and cleanup (after the PR merges and a deploy succeeds)

20. Push a tombstone commit to Core `main` (README: "Merged into
    esaueng/OpenCAE at <SHA>; archived read-only") and archive the GitHub repo.
21. Delete local checkouts: `~/claude/opencae-core` (the parked sibling) and
    `~/claude/open-cae-core` (after step 4's rescue). Decide the fate of
    `open-cae-dup`, `open-cae-gradient`, `open-cae-tierwork` — they are stale
    full clones and will not pick up the restructure; recommend deletion after
    checking each for unpushed branches (`git -C <dir> log --branches --not
    --remotes --oneline`).

## Interactions With Existing Plans

- **Closes plan 003** (reproducible core builds) — the unfrozen install exists
  only because of the sibling.
- **Delivers plan 011 Part A** (solver gates in CI) — Core package tests join
  the single CI pipeline; the `@opencae/core-cloud` filter trap dissolves
  because the duplicate package is deleted.
- **Unblocks the RUNNER_VERSION single-sourcing backlog item** — no more
  cross-repo component (and most of it retired with the cloud anyway).
- **Plans 015/016** (local-first) become single-repo work: solver hooks,
  mesh intake, and web UI change atomically in one PR from here on.
- Keeps the future option of publishing `@opencae/core` / `@opencae/solver-*`
  to npm from this repo if external consumers ever materialize — a strictly
  better distribution story than "clone my repo at this SHA".

## Risks And Mitigations

- **Lockfile regeneration churn**: transitive versions may move. Mitigate by
  reviewing the lock diff in isolation (its own commit) and running the full
  gate suite; the `fast-uri` override must survive.
- **Accidental `@opencae/web` collision**: guarded by dropping Core's
  `apps/web` at import time (step 6) before the workspace ever sees it.
- **Losing unmerged Core work on archive**: Phase 0 exists precisely for this;
  the PR description must list every Core branch and its disposition.
- **In-flight branches straddling the restructure**: any open open-cae branch
  touching `libs/opencae-core-adapter` or the workers will rebase noisily.
  Land Phase 0 first; keep the consolidation PR mechanical (moves + config),
  with zero behavior changes, so conflicts stay path-level.
- **Deploy regression**: `deploy:cloudflare:dry-run` is a required gate; the
  wrangler configs never referenced the sibling directly (verified — only the
  retirement guards mention core-cloud tokens, and those assertions stay).

## Considered And Rejected

- **Git submodule instead of merge**: the current pin+ensure-script machinery
  already is a hand-rolled submodule; submodules keep the two-commit lockstep
  and fix nothing.
- **Publishing Core to npm and consuming it as a registry dep**: adds a
  release/versioning pipeline for a library with exactly one consumer and one
  maintainer; strictly more process than the problem it solves. Revisit only
  if external consumers appear.
- **Importing only the consumed graph (core, examples, solver-cpu)**:
  solver-wasm/solver-webgpu are the plan-015/016 trajectory and viewer is
  ~free to carry; splitting Core's package set across "imported" and
  "abandoned in the archive" invites confusion for 490 KiB of savings.
