# OpenCAE Advisor Plans

Generated: 2026-06-12
Base commit: `3a67db9`
Scope: standard read-only survey of `/Users/userzero/codex/opencae-alpha`.

These plans are written for a fresh executor with no context from the survey. They are intentionally scoped to source changes that should be made by another implementation agent.

## Recon Summary

OpenCAE is a pnpm 9 / TypeScript monorepo with a React/Vite web app, Fastify local API, shared schema/storage/material/unit libraries, local services, a Cloudflare Worker deployment target, and a sibling `../opencae-core` workspace consumed at build time. CI runs Node 22, clones the pinned OpenCAE Core workspace, installs with `pnpm install --frozen-lockfile`, builds selected Core packages, verifies Cloudflare config and runner version, then runs `pnpm typecheck` and `pnpm test`.

Primary verification gates for implementation plans:

```sh
pnpm verify:cloudflare-config
pnpm verify:runner-version
pnpm typecheck
pnpm test
```

Full production build/deploy gates, when a plan touches build or Cloudflare behavior:

```sh
pnpm build
pnpm deploy:cloudflare:dry-run
```

Note: `pnpm build` currently runs `pnpm build:core`, which can invoke `pnpm install --no-frozen-lockfile`; see plan 003 before treating that command as a clean verification baseline.

## Prioritized Findings

| # | Finding | Category | Impact | Effort | Risk | Evidence |
| - | - | - | - | - | - | - |
| 1 | Result provenance classification can mark non-Core-Cloud actual-mesh local solves as `production_fea`, which drives bare `complete` run status. | Correctness / product truthfulness | High | M | Medium | `libs/opencae-schema/src/index.ts:384-404`, `apps/opencae-api/src/server.ts:457-479`, `libs/opencae-core-adapter/src/index.ts:99-127` |
| 2 | Opening/importing a saved project preserves the file's project/study/run ids and calls `upsertProject`, so an id collision can overwrite the local project and prune studies/runs. | Correctness / data integrity | High | M | Medium | `apps/opencae-api/src/server.ts:167-180`, `libs/opencae-db/src/index.ts:58-65`, `libs/opencae-db/src/index.ts:112-135`, `apps/opencae-web/src/projectFile.ts:45-59` |
| 3 | Local build scripts use an unfrozen install path while CI uses a frozen lockfile, making local production builds capable of mutating dependency state before verification. | DX / release integrity | Medium | S | Low | `package.json:9-13`, `.github/workflows/ci.yml:26-36`, `scripts/ensure-opencae-core.mjs:20-45` |
| 4 | Cloudflare Core Cloud run orchestration uses a non-atomic R2 `head` then `put` start claim and serves event streams as snapshot responses. Duplicate starts and stale UI progress are possible under concurrency or long solves. | Reliability | Medium | M | Medium | `apps/opencae-web/worker/index.ts:245-276`, `apps/opencae-web/worker/index.ts:653-665`, `apps/opencae-web/src/lib/api.ts:433-443` |
| 5 | Several regression tests assert source text instead of behavior, making refactors brittle and leaving important guarantees dependent on string placement rather than executable contracts. | Test coverage / DX | Medium | M | Low | `apps/opencae-web/src/performanceRewrite.test.ts:5-230`, `scripts/core-cloud-validation-docs.test.mjs:7-29`, `scripts/calculix-quarantine.test.mjs:65-92`, `apps/opencae-web/src/components/BottomPanel.test.tsx:90-94` |

## Direction Options

The existing `docs/validation/quality-accuracy-plan.md` is a strong CAE-number accuracy roadmap and should remain the source of truth for solver/reporting accuracy work. The plans here deliberately avoid duplicating it and instead target adjacent platform and workflow risks.

After these five plans, the next valuable direction is an executable product-level "open/save/import round trip" suite that drives the app through browser-visible workflows. It would catch several classes of current risks: id collision behavior, autosave/save parity, uploaded model embedding, and result bundle restore.

## Execution Order

1. `001-tighten-result-provenance-taxonomy.md`
2. `002-make-project-import-collision-safe.md`
3. `003-make-core-builds-reproducible.md`
4. `004-harden-cloud-worker-run-orchestration.md`
5. `005-replace-source-text-guard-tests.md`

Dependency notes:

- Plan 001 should land before any new report/UI labeling work, because it defines the load-bearing status taxonomy.
- Plan 002 is independent but should land before broader project-file features.
- Plan 003 is independent and lowers friction for all later verification.
- Plan 004 can run independently after current Worker tests are green.
- Plan 005 should be done after plans 001 and 004 if those plans touch tests that currently use source-string assertions.

## Status

| Plan | Status | Owner Notes |
| - | - | - |
| 001 Tighten result provenance taxonomy | TODO | Highest leverage correctness fix. |
| 002 Make project import collision-safe | TODO | Prevents local data loss on open/import. |
| 003 Make Core builds reproducible | TODO | Improves CI/local parity. |
| 004 Harden Cloud Worker run orchestration | TODO | Requires careful Worker/R2 tests. |
| 005 Replace source-text guard tests | TODO | Reduces brittle tests after behavior is covered. |

## Considered And Rejected

- Report truthfulness follow-up: rejected for this run because `services/opencae-post-service/src/index.ts` already labels schematic visuals, escapes HTML, includes provenance fields, and marks local estimates as "NOT ANALYSIS".
- Generic storage traversal hardening: rejected as a top finding because `FileSystemObjectStorageProvider.getLocalPath` already rejects absolute and parent-directory traversal keys. Symlink hardening may still be useful, but it is lower leverage for the current local app threat model.
- Broad CAE accuracy benchmark work: deferred because `docs/validation/quality-accuracy-plan.md` already contains a detailed phased plan.

## Not Audited

- The sibling `../opencae-core` implementation was not audited directly in this pass.
- Live Cloudflare resources, production logs, R2 bucket contents, and deployed health endpoints were not queried.
- A browser-rendered UX review was not performed.
- Dependency vulnerability status was not checked with an online audit command.
