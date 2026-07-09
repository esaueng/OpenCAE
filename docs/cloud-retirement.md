# OpenCAE Core Cloud retirement (July 2026)

OpenCAE went fully local-first in July 2026: every simulation meshes and solves
in the browser with OpenCAE Core (wasm meshing since A-M4, local solve pipeline
since B4a). The cloud solve infrastructure was removed in two steps:

- **B4a** removed the client cloud-solve path (request builder, run dispatch,
  cloud event streaming, backend picker cloud option).
- **B4b** (this note) removed the server-side infrastructure and deploy
  tooling. **B5** added a guard test so none of it can silently return.

## What was removed (B4b)

- **Worker routes** (`apps/opencae-web/worker/index.ts`): `/api/cloud-core/*`
  and legacy alias `/api/cloud-fea/*` — run creation, start, events, results,
  cancel, and the Core Cloud health check, plus run tokens
  (`x-opencae-run-token`, `auth.json`), the R2 artifact read/write under
  `cloud-core/runs/*`, the `EXPECTED_CORE_CLOUD_RUNNER_VERSION` fail-closed
  gate, and the container fetch timeouts. Retired routes now return an honest
  **HTTP 410** ("cloud solve retired — solves run locally in your browser").
  The Worker keeps serving the SPA static assets with security headers.
- **Container service mirror**: `services/opencae-core-cloud/` (Dockerfile,
  `RUNNER_VERSION`, contract-mirror source, its validation tests). The browser
  build now consumes OpenCAE Core directly from this monorepo's `packages/*`
  workspace packages.
- **Wrangler configs**: container, Durable Object (`CORE_CLOUD_CONTAINER` /
  `OpenCaeCoreCloudContainer`), and R2 (`CORE_CLOUD_ARTIFACTS`) bindings.
  `wrangler.containers.jsonc` was deleted; the former
  `wrangler.local-first.jsonc` shape was promoted into `wrangler.jsonc`
  (production identity kept: Worker name `opencae`, custom domain
  `cae.esau.app`). `wrangler.static.jsonc` remains the non-production variant.
  The checked-in config carries **no migrations** — Workers Builds uploads PR
  preview versions, and pending Durable Object migrations cannot ride a
  version upload (this failed CI on PR #31 until removed).

  **Durable Object cleanup (one-off manual deploy step):** once rollback is
  ruled out, delete the retired container class by deploying once with
  `wrangler.retired-do-cleanup.jsonc`. This separate config targets the same
  production Worker and carries only the Durable Object migration history:

  ```jsonc
  "migrations": [
    { "tag": "v3-opencae-core-cloud-container", "new_sqlite_classes": ["OpenCaeCoreCloudContainer"] },
    { "tag": "v4-retire-opencae-core-cloud-container", "deleted_classes": ["OpenCaeCoreCloudContainer"] }
  ]
  ```

  Run `pnpm deploy:cloudflare:retired-do-cleanup` once from an authenticated
  Wrangler session. After that server-side migration is recorded, normal
  Cloudflare Builds should keep using `npx wrangler deploy` with the default
  migration-free `wrangler.jsonc`.
- **Deploy/CI gates for the cloud path**: `scripts/verify-runner-version.mjs`
  and its CI step; the container assertions in
  `scripts/verify-cloudflare-config.mjs` (now asserting the bindings stay
  ABSENT); `deploy:core-cloud*`, `containers:build:core-cloud`,
  `containers:push:core-cloud`, `test:core-cloud*` package scripts; the
  `@cloudflare/containers` dependency.

## What deliberately stays

- **Golden fixtures + recorder**
  (`apps/opencae-web/src/testdata/core-cloud-golden/`,
  `scripts/record-core-cloud-golden.mts`, `coreCloudGolden.test.ts`,
  `goldenParity.test.ts`): they freeze the retired runner's exact
  request/response contract, and the local pipeline must keep reproducing it.
- **Historical provenance labeling**: results solved on the cloud before the
  retirement keep their "OpenCAE Core Cloud" / cloud-container labels — old
  data is labeled truthfully, never re-attributed.
- **Schema alias**: `solverSettings.backend: "opencae_core_cloud"` still
  parses (as an alias for `auto`) so old project files round-trip; loading one
  logs a one-time migration note.
- **OpenCAE Core packages**: `packages/core`, `packages/examples`,
  `packages/solver-cpu`, `packages/solver-wasm`, `packages/solver-webgpu`, and
  `packages/viewer` are now part of this repository and build before the web
  bundle.
- **The guard**: `scripts/cloud-retirement-guard.test.mjs` fails CI if any
  retired surface token reappears outside a short, justified allowlist.

## Rollback (if ever needed)

- The last-good container image is `opencae/opencae-core-cloud:0.1.6`
  (Cloudflare container application `opencae-core-cloud-0.1.1`).
- The runner source remains buildable from the sibling **opencae-core** repo
  (`services/opencae-core-cloud` there); the golden fixtures record the exact
  ref (`meta.coreRef = 5fff27782df894ecf28d65097f63461d69771f16`) and contract.
- Restoring would mean reverting the B4b/B5 commits and redeploying with a
  container-bearing wrangler config. The guard test exists precisely so this
  is a loud, deliberate act.

## Open items (owner decisions — not automated here)

- **R2 bucket `opencae-core-cloud-artifacts` (`cloud-core/runs/*`)**: the
  binding is gone but the bucket and its historical run artifacts still exist
  in Cloudflare. Retention vs. export vs. deletion is an open owner decision.
  Nothing in this repo reads or writes it anymore; no data was deleted.
- **Cloudflare cleanup**: the container application and any pushed images can
  be deleted from the Cloudflare account once rollback is ruled out (manual,
  intentionally not scripted).
- **LICENSE / THIRD_PARTY_NOTICES review**: the shipped app no longer
  distributes or invokes the cloud container stack; worth a pass to confirm
  attributions still match what ships.

## Repo consolidation coda

OpenCAE Core was consolidated into this monorepo in July 2026 from Core commit
`bc6c305272bd2789634f5e4c9006e0eae21e116b`, the production-equivalent solver
lineage used by the local browser build. The imported packages live under
`packages/*`, Core reference docs live under `docs/core/`, and the old Core
advisory plans rescued from the stale checkout live under `docs/core/plans/`.

After this consolidation, a fresh checkout of this repository plus
`pnpm install --frozen-lockfile` is the build source of truth. The former
OpenCAE-Core GitHub repository can be tombstoned and archived after this branch
lands and the production deploy is verified.
