# Repository instructions

## Project

OpenCAE is a pnpm monorepo for a local-first browser CAD/CAE workspace. The production path is the React/Vite web app plus a Cloudflare Worker that serves static assets and consent-gated encrypted recovery backups; geometry import, meshing, solving, results, and reports run in the browser.

`apps/opencae-api` and `services/*` form a separately runnable reference backend. They are not the production solve path and are not included by `pnpm build:cloudflare`.

## Enforced boundaries

- `packages/*` are emitted TypeScript packages whose exports point at `dist`. Build them before typechecking or building consumers. The root `build:core` script and CI encode the required dependency order.
- `pnpm build:cloudflare` builds only the core packages and `apps/opencae-web`. `scripts/verify-cloudflare-config.mjs`, run by CI, rejects retired solver/container bindings from the production config, validates the one-off Durable Object deletion migration, and verifies the Worker asset and encrypted-backup bindings.
- There is no general architecture-boundary linter. Package manifests, TypeScript resolution, the production build, and the Cloudflare verifier are the machine-enforced boundaries; do not claim stronger separation than they provide.

## Setup and CI verification

Run commands from the repository root. Install with `pnpm install --frozen-lockfile` (requires registry access; defined by CI, not run during the 2026-08-11 audit).

`.github/workflows/ci.yml` is the verification contract. Run its commands in this order before pushing:

```sh
pnpm --filter @opencae/core build
pnpm --filter @opencae/examples build
pnpm --filter @opencae/solver-cpu build
pnpm --filter @opencae/solver-webgpu build
pnpm --filter @opencae/viewer build
pnpm --filter "./packages/*" --if-present test
node scripts/verify-cloudflare-config.mjs
pnpm typecheck
pnpm test
pnpm verify:step-selection-browser
pnpm build:cloudflare
pnpm --filter @opencae/web check:bundle
```

`verify:step-selection-browser` requires Chrome or Chromium and free local ports 5198 and 9336; set `CHROME_BIN` when auto-detection cannot find the browser. The bundle check reads `apps/opencae-web/dist`, so it must follow `build:cloudflare`.

There is no root lint script and CI has no lint job. The five `packages/*` lint scripts are aliases for their typechecks; `pnpm typecheck` is the workspace-wide check.

Re-verified 2026-08-15: every command in the block passes, including `pnpm test` (1,569 tests). The earlier known baseline failure in `apps/opencae-web/src/cloudBackup.test.ts` — a mocked backup expiring at `2026-08-11T12:00:00.000Z`, audited 2026-08-11 — no longer exists; the fixture now uses relative and far-future dates.

Do not use `deploy:*`, `db:*`, or `reset:local` as verification commands. They require credentials, external state, or mutate local data; run them only when the task explicitly requires that operation.

## Non-obvious invariants

- STEP source geometry and exported STEP data stay analytic. `stepDisplayTessellation.ts` controls display-only detailed/balanced meshes; changing visual tessellation must not replace or rewrite the exact STEP source.
- Supports, loads, and named selections persist B-rep face IDs and fingerprints. Both display LODs must map picks to the same identities across model scales; `pnpm verify:step-selection-browser` enforces this in real Chrome.
- Coordinate systems are explicit. Core models accept `m-N-s-Pa` or `mm-N-s-MPa`, while display geometry may use a different coordinate space. Preserve `coordinateSystem.solverUnits` and `renderCoordinateSpace`; use the existing `@opencae/units` and mesh-intake conversion paths instead of inferring units from magnitudes.
- Computed production fields must remain tied to the solver surface mesh. `packages/core` validates field length/alignment and provenance; preview, estimate, benchmark, legacy, and computed FEA tiers must not be relabeled as one another.
- The production web build intentionally rewrites the emitted raw Gmsh WASM into a gzip asset plus `gmsh-wasm.json`, then generates the service-worker precache. Keep that build ordering; the Vite plugin and final bundle-budget command enforce the per-asset and precache limits.
- The Worker still owns `/api/project-backups` and `/health`; those routes do not make `apps/opencae-api` part of production. Keep browser solves local and use `verify-cloudflare-config` after changing Wrangler files or deploy scripts. A daily cron trigger (`17 3 * * *`) sweeps the backup bucket and deletes objects past their 30-day expiry, because request-time expiry only runs when an expired backup is read.
