# OpenCAE

[![Production health](https://img.shields.io/website?url=https%3A%2F%2Fcae.esau.app%2Fhealth&label=production%20health)](https://cae.esau.app/health)

OpenCAE is a local-first CAD/CAE simulation workspace: set up a structural study, solve it in the browser with OpenCAE Core, and review the results. It supports static stress and dynamic structural studies, sample projects, local `.opencae.json` project files, uploaded geometry previews, browser-local CPU solves, and HTML/PDF report export.

The project is organized around service boundaries so the React workspace, Fastify API, CAD import, meshing, OpenCAE Core solver, post-processing, storage, and job runners can evolve independently.

## Local Development

OpenCAE consumes the live OpenCAE Core workspace from a sibling checkout. Keep the repos beside each other (only the relative layout matters):

```text
<workspace>/open-cae
<workspace>/opencae-core
```

Run `pnpm ensure:core` (or any build command) to clone `https://github.com/esaueng/OpenCAE-Core` into the sibling path at the commit pinned in [OPENCAE_CORE_REF](OPENCAE_CORE_REF). Set `OPENCAE_CORE_DIR` to use a different location.

Install dependencies and start the API and web app from the repo root:

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts:

- API: `http://localhost:4317`
- Web: `http://localhost:5173`

The API creates and seeds the local SQLite database if needed. The web app can create a blank project, open a local `.opencae.json` project file, load bracket/beam/cantilever samples, or upload STEP, STP, STL, and OBJ models for the local viewer.

## Current Workflow

OpenCAE guides a study through Model, Material, Supports, Loads, Mesh, Run, Results, and Report steps:

- Choose a static stress or dynamic structural study when creating a project.
- Load built-in bracket, beam, or cantilever samples in static or dynamic mode.
- Upload geometry, inspect selectable faces, show dimensions, and adjust model orientation.
- Assign starter materials, including additive-manufacturing print settings that affect effective material properties.
- Add fixed supports and force, pressure, or payload-weight loads.
- Generate coarse, medium, fine, or ultra mesh summaries for local analysis sampling.
- Run local simulations with progress events, logs, cancellation, result artifacts, HTML reports, and PDF reports.
- Inspect stress, displacement, safety factor, velocity, and acceleration fields where available.
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
```

## Cloudflare Worker Deploy

The production Cloudflare target for `cae.esau.app` serves the Vite web app from Workers Static Assets. Simulations run entirely in the browser with OpenCAE Core — the Worker hosts no solver. (The former OpenCAE Core Cloud container/R2 solve path was retired in July 2026; see [docs/cloud-retirement.md](docs/cloud-retirement.md).)

```bash
pnpm install
pnpm deploy:cloudflare
```

Build and deploy environments use `pnpm build:core` to ensure `https://github.com/esaueng/OpenCAE-Core` exists as `../opencae-core`, update that checkout to the pinned commit in `OPENCAE_CORE_REF` (repo root), rerun `pnpm install --no-frozen-lockfile`, and then build the live Core packages consumed through this workspace. Production builds require that ref to be a full commit SHA so build artifacts are reproducible. `pnpm` resolves `@opencae/core`, `@opencae/solver-cpu`, and other OpenCAE Core packages from that sibling workspace; there is no runtime network lookup.

Production deploys use the default [wrangler.jsonc](wrangler.jsonc) (static assets + security headers only, no solver bindings).

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

The `/health` route verifies the production Worker is reachable and reports `solverRuntime: "browser-opencae-core"`. There is no separate solver-readiness endpoint: the solver ships inside the app bundle and runs in the browser. Retired cloud solve routes return HTTP 410.

## Workspace Layout

- `apps/opencae-web` - React/Vite CAD workspace for static and dynamic structural workflows.
- `apps/opencae-api` - Fastify API for projects, uploads, studies, jobs, artifacts, reports, and service orchestration.
- `../opencae-core/packages/*` - Live sibling OpenCAE Core packages consumed through the pnpm workspace.
- `libs/*` - Shared schema, units, materials, storage, jobs, validation (study-core), database, and core-adapter packages.
- `services/*` - CAD, mesh, solver, post-processing, and legacy container reference implementations. (The `opencae-core-cloud` runner mirror was removed in the July 2026 cloud retirement.)
- `runners/opencae-runner-local` - Local runner package for job execution flows.
- `examples/*` - Sample project documentation and fixtures.
- `docs/*` - Architecture, local development, file format, validation, and user guide notes.
- `infra/local/*` - Local SQLite, storage, and jobs setup notes.
- `data/*` - Local runtime data directories for artifacts, logs, reports, uploads, and SQLite state.

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
