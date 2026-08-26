# OpenCAE

[![Production health](https://github.com/esaueng/OpenCAE/actions/workflows/production-health.yml/badge.svg?branch=main)](https://github.com/esaueng/OpenCAE/actions/workflows/production-health.yml)

OpenCAE is an engineering-preview, local-first browser CAD/CAE workspace for structural and thermal simulation. Import CAD or create an analytic STEP part, define a study, mesh and solve it in the browser with OpenCAE Core, inspect the results, and export a self-contained project or report.

The workspace supports linear static stress, transient structural dynamics, modal analysis, and steady-state thermal conduction. Built-in samples, local `.opencae.json` project files, STEP/STP/STL/OBJ uploads, browser-local solves, selected-state CSV/VTU export, and HTML/PDF reports work without a production API or cloud solver.

**Privacy:** projects, geometry, meshes, and results never leave the browser. The only optional server flow is the consent-gated, client-side-encrypted 30-day recovery backup (the server stores ciphertext it cannot read). The deployed app also sends anonymous usage analytics (page views and outbound-link clicks) to Plausible; no project or simulation data is tracked, and you can turn it off anytime from the Storage card in the toolbar.

## Local Development

Install dependencies and start the API and web app from the repo root:

```bash
pnpm install --frozen-lockfile
pnpm dev
```

OpenCAE Core packages live in this monorepo under `packages/*`; no sibling checkout or pin bootstrap is required.

`pnpm dev` starts:

- API: `http://localhost:4317`
- Web: `http://localhost:5173`

The API creates and seeds the local SQLite database if needed. The web app can create a blank project, open a local `.opencae.json` project file, load bracket/beam/cantilever samples, or upload STEP, STP, STL, and OBJ models for the local viewer.

**The web app does not call the API.** Since the July 2026 local-first move ([docs/cloud-retirement.md](docs/cloud-retirement.md)), the workspace creates projects, meshes, solves, and writes reports entirely in the browser; it makes no request to `/api`. `apps/opencae-api` and the `services/*` implementations behind it are a separate, independently runnable reference backend over the same schema — useful for inspecting the data model or driving the flow over HTTP, but not part of the production path. `pnpm dev` starts both so the reference backend stays exercised; running only `pnpm --filter @opencae/web dev` gives you the full product.

> **Security note:** the reference API has no authentication or tenant isolation by design. It binds `127.0.0.1` by default and must stay loopback-only; never expose it as a shared or network-reachable service. The server logs a warning if started on a non-loopback host.

## Current Workflow

OpenCAE guides a study through Model, Material, Supports, Loads, Mesh, Run, Results, and Report steps:

- Choose a static stress, dynamic structural, modal, or steady-state thermal study.
- Start from a blank project, an analytic parametric STEP part, or a bracket, beam, or cantilever sample.
- Upload STEP, STP, STL, or OBJ geometry; inspect selectable faces; show dimensions; and adjust model orientation.
- Assign starter materials, including additive-manufacturing print settings that affect effective material properties.
- Add structural supports, temperature boundaries, loads, and multi-body connections as the study requires.
- Generate coarse, medium, fine, or ultra volume meshes for local analysis.
- Run local simulations with progress events, logs, cancellation, result artifacts, HTML reports, and PDF reports.
- Inspect stress, displacement, safety factor, velocity, acceleration, natural frequencies, mode shapes, temperature, and heat flux where available.
- Play dynamic result frames with cached playback preparation for smoother browser rendering.
- Save a self-contained local project file with embedded uploaded model data and completed results.

## Useful Commands

```bash
pnpm db:migrate
pnpm db:seed
pnpm reset:local
pnpm build
pnpm typecheck
pnpm test
pnpm verify:perf
node scripts/check-production-health.mjs
```

## Cloudflare Worker Deploy

The production Cloudflare target for `cae.esau.app` serves the Vite web app from Workers Static Assets. Simulations run entirely in the browser with OpenCAE Core — the Worker hosts no solver. If browser autosave overflows, the app can ask for explicit permission to upload a client-encrypted 30-day recovery snapshot; the Worker never receives its decryption key. (The former OpenCAE Core Cloud container/R2 solve path was retired in July 2026; see [docs/cloud-retirement.md](docs/cloud-retirement.md).)

```bash
pnpm install --frozen-lockfile
pnpm deploy:cloudflare
```

Build and deploy environments use `pnpm build:core` to build the in-repo OpenCAE Core packages before the web bundle. Production deploys require only this repository plus the checked-in lockfile; there is no runtime or build-time fetch of a second repo.

Production deploys use the default [wrangler.jsonc](wrangler.jsonc) (static assets, security headers, and the encrypted recovery-backup binding; no solver bindings).

For a separate non-production static Worker deploy, use:

```bash
pnpm deploy:cloudflare:static:dry-run
pnpm deploy:cloudflare:static
```

That static path uses [wrangler.static.jsonc](wrangler.static.jsonc), which targets `opencae-static` and intentionally omits the production custom domain routes.

For Cloudflare Builds, use:

```text
Build command: pnpm run build
Deploy command: npx wrangler deploy
```

`pnpm deploy:cloudflare` is also valid as a deploy command. Do not use `npx wrangler versions upload` for the production Worker: version uploads cannot apply the retired container Durable Object cleanup path and can leave Cloudflare rejecting stale `OpenCaeCoreCloudContainer` state. Do not use the static deploy command for the production Worker.

If Cloudflare rejects a deploy with code `10064` for `OpenCaeCoreCloudContainer`, run the one-off cleanup deploy from an authenticated Wrangler session:

```bash
pnpm deploy:cloudflare:retired-do-cleanup
```

That records the retired Durable Object delete-class migration server-side. After it succeeds, return to the normal `npx wrangler deploy` / `pnpm deploy:cloudflare` path.

## Production Uptime

The live app runs at `https://cae.esau.app`. Uptime monitors should check the Worker health endpoint:

```bash
curl -fsS https://cae.esau.app/health
```

The scheduled [Production Health workflow](.github/workflows/production-health.yml) checks this contract every 30 minutes and powers the badge at the top of this README. It requires HTTP 200 plus the expected Worker, service, and `solverRuntime: "browser-opencae-core"` fields, so a generic success page cannot produce a false green result.

This endpoint proves that the production Worker is reachable and serving the expected local-first release contract. It is not a separate solver-readiness probe: the solver ships inside the app bundle and runs in the browser. Retired cloud solve routes return HTTP 410.

## Workspace Layout

- `apps/opencae-web` - React/Vite CAD workspace for static and dynamic structural workflows.
- `apps/opencae-api` - Fastify reference API for projects, uploads, studies, jobs, artifacts, reports, and service orchestration. Not on the production path; the web app does not call it.
- `packages/*` - OpenCAE Core model, examples, CPU solver, WebGPU solver, and viewer packages. (The never-implemented `solver-wasm` placeholder was removed in July 2026; browser WebAssembly is Gmsh meshing in `libs/opencae-mesh-intake`.)
- `libs/*` - Shared schema, units, materials, storage, jobs, validation (study-core), database, mesh intake, solve pipeline, and core-adapter packages.
- `services/*` - CAD, mesh, solver, and post-processing reference implementations behind the reference API, plus a legacy CalculiX container note. (The `opencae-core-cloud` runner mirror was removed in the July 2026 cloud retirement.)
- `runners/opencae-runner-local` - Local runner package for job execution flows.
- `examples/*` - Sample project documentation and fixtures.
- `docs/*` - Architecture, local development, file format, validation, and user guide notes.
- `infra/local/*` - Local SQLite, storage, and jobs setup notes.
- `data/*` - Local runtime data directories for the reference API: `artifacts` (including each project's uploads), `logs`, `reports`, and `sqlite` state.

## Simulation Flow

OpenCAE treats CAD entities as the source of truth. Meshes are generated artifacts, while results and reports are immutable study-run artifacts. Loads, supports, contacts, and named selections bind to CAD topology references so the data model can survive backend changes without rewriting the user workflow.

The built-in bracket, beam, and cantilever demos ship with Aluminum 6061 and 3D-printing material presets, supports, payload/force loads, generated mesh summaries, and local report artifacts.

## Solver Attribution

Production solving runs in the browser with OpenCAE Core and is labeled as local computed FEA. Results must carry `opencae_core_fea`, `computed` result provenance, and `actual_volume_mesh` or `structured_block_core` mesh provenance; preview estimates must never be displayed as production FEA. Results solved on the retired OpenCAE Core Cloud (before July 2026) keep their historical cloud provenance labels — old data stays truthfully attributed.

## Documentation

- [Architecture](docs/architecture/README.md)
- [Local development](docs/local-development/README.md)
- [User guide](docs/user-guide/README.md)
- [File format](docs/file-format/README.md)
- [Validation](docs/validation/README.md)
- [Cloud retirement (2026-07)](docs/cloud-retirement.md)

## License

OpenCAE source code is licensed under the Apache License 2.0.

OpenCAE may invoke or distribute separately licensed third-party tools and
libraries, including OCCT/occt-import-js components. Those
components are not relicensed under Apache-2.0. See [NOTICE](NOTICE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for details.

Copyright 2026 Esau Engineering. The OpenCAE name and logo are trademarks of Esau Engineering.

## Scope

OpenCAE is still an engineering preview. OpenCAE Core results are development-oriented analysis outputs and should not be treated as certified analysis. Native CAD, meshing, and post-processing support continue to evolve behind the existing service boundaries.
