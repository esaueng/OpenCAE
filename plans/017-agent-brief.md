# Agent Brief: Execute Plan 017 — Sunset OpenCAE-Core (Monorepo Consolidation)

You are executing a repo consolidation for the OpenCAE project. This brief is
self-contained; the full rationale lives in
`plans/017-sunset-core-repo-monorepo-consolidation.md` (source of record — read
it first, follow this brief for execution order and stop points).

## Mission

Merge the sibling OpenCAE-Core repository into open-cae so that a fresh clone
of open-cae builds, tests, and deploys with **no sibling checkout, no
`OPENCAE_CORE_REF` pin file, and no bootstrap scripts**. Then archive the Core
repo without losing any work.

## Environment map

| Thing | Location |
| - | - |
| Main repo (you work here) | `/Users/userzero/claude/open-cae` → `github.com/esaueng/OpenCAE` |
| Live Core sibling (pinned checkout) | `/Users/userzero/claude/opencae-core` → `github.com/esaueng/OpenCAE-Core` |
| OLD Core checkout with unpushed work | `/Users/userzero/claude/open-cae-core` (note the hyphens — different dir!) |
| Stale open-cae clones (retire last) | `/Users/userzero/claude/open-cae-{dup,gradient,tierwork}` |
| Core pin | root file `OPENCAE_CORE_REF` = `bc6c305272bd2789634f5e4c9006e0eae21e116b` |

Toolchain: pnpm 9 (`packageManager` pinned), Node 22, TypeScript, Vitest.
Deploys go to Cloudflare via wrangler; production is `cae.esau.app`.

## Ground rules

1. **Never delete or archive anything before its rescue step has run and been
   verified.** The archive steps are last for a reason.
2. The consolidation PR (Phases 1–2) must be **mechanical only**: file moves,
   config, lockfile. Zero behavior changes. If you find yourself editing
   solver or app logic, stop — you've left the plan.
3. Known pre-existing failure: `pnpm typecheck` fails in
   `apps/opencae-web/src/workers/localCantileverAccuracy.test.ts` from earlier
   WIP. This is NOT yours to fix and NOT a regression gate — compare failures
   against a baseline run you take before changing anything.
4. Commit messages end with:
   `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
5. Work on branches; never commit directly to `main` of either repo.

## Stop points (require maintainer sign-off before proceeding)

- **S1** — before merging anything in the Core repo (Phase 0 steps 2–3): post
  your branch-state findings and proposed merges, wait for approval.
- **S2** — before merging the Phase 1+2 consolidation PR: all Phase 3 gates
  green, PR description complete (see template below).
- **S3** — before ANY archive/deletion in Phase 5: confirm production deploy
  succeeded after the merge, then ask.

## Phase 0 — Reconcile sources of truth

Pre-verified facts (2026-07-09; re-verify, they may have moved):

- Core's production pin `bc6c305` is the head of branch
  `feat/solver-progress-hooks`, **5 commits ahead of Core `origin/main`**
  (contains `fix/render-ready-results`'s 4 commits). Core `main` is stale.
- Core branch `security/redact-secrets` has 1 unmerged commit — triage it.
- All other Core branches (`audit-fixes`, `improvement-plans`,
  `fix/bracket-tet10-inverted-jacobian`, `solver-accuracy-0.1.5`) are fully
  merged.
- The OLD checkout `~/claude/open-cae-core` (branch `improvement-plans`) has an
  **uncommitted** `plans/README.md` edit and **untracked** files
  `plans/006-*.md` through `plans/009-*.md` (Core advisor plans).

Steps:

1. In open-cae: confirm the working tree is clean and `main` is the agreed
   base. If plan-016 WIP (mesh worker files) or the unmerged
   `sync/reconcile-origin-main` branch are still outstanding, report and stop —
   those land first, not by you.
2. Rescue the old checkout: in `~/claude/open-cae-core`, commit the
   `plans/README.md` edit + plans 006–009 to `improvement-plans` and push.
   Also copy the four plan files into open-cae at `docs/core/plans/` so they
   survive the archive regardless.
3. [S1] In the live Core checkout: propose merging `feat/solver-progress-hooks`
   → `main` (should be a fast-forward or trivial merge) and a disposition for
   `security/redact-secrets`. On approval, merge and push.
4. Record the final Core `main` SHA. This is the import point. Verify
   `git merge-base --is-ancestor bc6c305 <that SHA>` is true.

## Phase 1 — Import (same PR as Phase 2; do not split)

Branch: `feat/017-sunset-core-repo` in open-cae.

5. Import Core at the recorded SHA (use `git subtree add`, then move files in
   follow-up commits; Core history is only 11 commits):
   - Core `packages/{core,examples,solver-cpu,solver-wasm,solver-webgpu,viewer}`
     → open-cae `packages/<same name>`
   - Core `{ARCHITECTURE,BENCHMARKS,ROADMAP,PROJECT_BRIEF,PLANS,AGENTS}.md` and
     `docs/validation` → open-cae `docs/core/`
   - **Delete on import** (never let the workspace see them): Core `apps/web`
     (package name `@opencae/web` collides with `apps/opencae-web`) and Core
     `services/opencae-core-cloud` (retired; name collides with the historical
     mirror). Also delete Core's root `package.json`, `pnpm-workspace.yaml`,
     `pnpm-lock.yaml`, `tsconfig.base.json`.
6. `pnpm-workspace.yaml`: delete the `"../opencae-core/packages/*"` line. The
   `"packages/*"` glob already exists — no other workspace edit.
7. Toolchain alignment: Core pins TS 5.9.3 / Vite 6.4.2 vs root TS 5.7.3.
   Standardize the root on the newer TS line; imported packages must extend
   the repo's `tsconfig.base.json`; remove duplicated per-package devDeps
   where the root already provides them.
8. Add `"license": "Apache-2.0"` to each imported package.json (Core had no
   LICENSE file). Extend `THIRD_PARTY_NOTICES.md` only if an imported package
   vendors third-party code.

## Phase 2 — Decouple build, lockfile, CI (same PR)

9. Delete: `OPENCAE_CORE_REF`, `scripts/ensure-opencae-core.mjs`,
   `scripts/ensure-opencae-core.test.mjs`,
   `scripts/verify-core-ref-reachable.mjs`,
   `scripts/verify-core-ref-reachable.test.mjs`.
10. Root `package.json`: remove `ensure:core` and `verify:core-ref`; rewrite
    `build:core` as filtered builds with **no install step** (the
    `pnpm install --no-frozen-lockfile` inside it goes away — this closes
    plan 003); strip `verify:core-ref` from all `deploy:cloudflare*` chains.
11. Regenerate `pnpm-lock.yaml` once, in its own commit. Verify the
    `fast-uri: 3.1.2` override survives and review the importer diff.
12. `.github/workflows/ci.yml`: delete the "Clone pinned OpenCAE Core sibling
    workspace" step; the core build step now builds in-repo paths; add
    `pnpm --filter "./packages/*" test` so the solver accuracy gates run per
    PR (this delivers plan 011 Part A).
13. Sweep guard scripts for stale assertions about the pin/sibling:
    `scripts/cloud-retirement-guard.test.mjs`,
    `scripts/core-cloud-validation-docs.test.mjs`,
    `scripts/verify-cloudflare-config.mjs` (its retirement-token checks stay).
    Add one new guard test: no file outside `docs/` and `plans/` may contain
    `../opencae-core` or `OPENCAE_CORE_REF`.

## Phase 3 — Gates (all must pass before S2)

14. Take the pre-change baseline FIRST (before Phase 1) so you can tell
    pre-existing failures from regressions.
15. Park the sibling: `mv ~/claude/opencae-core ~/claude/opencae-core.parked`.
    Then, from a state with `node_modules` removed:
    ```sh
    pnpm install --frozen-lockfile
    pnpm build
    pnpm typecheck        # localCantileverAccuracy failure = pre-existing, OK
    pnpm test
    pnpm verify:cloudflare-config
    pnpm deploy:cloudflare:dry-run
    ```
16. CI green on the PR (no clone step).
17. `grep -rn "opencae-core\|OPENCAE_CORE" --exclude-dir=node_modules --exclude-dir=.git .`
    hits only `docs/`, `plans/`, and lockfile-free historical references.
18. Restore the sibling name afterward (it is deleted only in Phase 5).

## Phase 4 — Docs (same PR or immediate follow-up)

19. Update `README.md`, `docs/architecture/README.md`,
    `docs/local-development/README.md` (no sibling-clone setup step), the
    recon summary in `plans/README.md`, and add a consolidation coda to
    `docs/cloud-retirement.md` (date, final Core SHA, disposition map).
    Mark plan 017 Status = DONE and plan 003 accordingly.

## Phase 5 — Archive and cleanup [S3 first]

20. Push a tombstone commit to Core `main`: README top says "Merged into
    esaueng/OpenCAE at <SHA>; this repo is archived read-only." Archive the
    GitHub repo via `gh repo archive esaueng/OpenCAE-Core`.
21. Delete `~/claude/opencae-core.parked` and `~/claude/open-cae-core` (only
    after step 2's rescue is verified pushed). For each of `open-cae-dup`,
    `open-cae-gradient`, `open-cae-tierwork`: run
    `git log --branches --not --remotes --oneline` and
    `git status --porcelain`; report anything unpushed before deleting.

## PR description template (for S2)

- What moved where (the disposition table from plan 017).
- Every Core branch and its fate (merged / rejected-with-reason).
- Lockfile diff summary.
- Gate results, including the pre-existing typecheck failure called out
  explicitly as pre-existing (with baseline evidence).

## Definition of done

- [ ] Fresh-clone build/test/typecheck/dry-run deploy passes with no sibling present
- [ ] Core's 6 packages under `packages/*`, tests running in CI
- [ ] Pin file + 4 bootstrap scripts deleted; all installs frozen
- [ ] Apache-2.0 on every imported package
- [ ] Core repo archived with tombstone; zero unpushed work lost
- [ ] Plans 003 and 017 marked done; plan 011 Part A noted delivered
