# OpenCAE

[![Production health](https://img.shields.io/website?url=https%3A%2F%2Fcae.esau.app%2Fhealth&label=production%20health)](https://cae.esau.app/health)

OpenCAE is a local-first CAD/CAE simulation workspace for structural study setup, fast OpenCAE Core solves, and browser-based result review. The current app supports static stress and dynamic structural studies, sample projects, local project files, uploaded geometry previews, browser-local OpenCAE Core CPU solves, and report export.

The project is organized around service boundaries so the React workspace, Fastify API, CAD import, meshing, OpenCAE Core solver, post-processing, storage, and job runners can evolve independently.

## Local Development

OpenCAE consumes the live OpenCAE Core workspace from a sibling checkout. Keep the repos beside each other:

```text
/Users/userzero/codex/opencae-alpha
/Users/userzero/codex/opencae-core
```

Install dependencies and start the API and web app from `opencae-alpha`:

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
pnpm test
pnpm verify:perf
```

## Cloudflare Worker Deploy

The production Cloudflare target for `cae.esau.app` serves the Vite web app from Workers Static Assets and routes production solves through OpenCAE Core Cloud. The default deploy path builds the web app, deploys the Worker asset binding, enables SPA fallback routing, and binds the versioned Core Cloud container, Durable Object, and R2 artifact bucket.

```bash
pnpm install
pnpm deploy:cloudflare
```

Build and deploy environments use `pnpm build:core` to ensure `https://github.com/esaueng/OpenCAE-Core` exists as `../opencae-core`, update that checkout to the pinned commit in `services/opencae-core-cloud/OPENCAE_CORE_REF`, rerun `pnpm install --no-frozen-lockfile`, and then build the live Core packages consumed through this workspace. Production builds require that ref to be a full commit SHA so container artifacts are reproducible. `pnpm` resolves `@opencae/core`, `@opencae/solver-cpu`, and other OpenCAE Core packages from that sibling workspace; there is no runtime network lookup.

Production deploy scripts use [wrangler.containers.jsonc](wrangler.containers.jsonc) for the app domain and container rollout. [wrangler.jsonc](wrangler.jsonc) mirrors the Core Cloud production bindings so a default production config cannot publish an unbound Worker.

For a separate static Worker deploy, use:

```bash
pnpm deploy:cloudflare:static:dry-run
pnpm deploy:cloudflare:static
```

That static path uses [wrangler.static.jsonc](wrangler.static.jsonc), which targets `opencae-static` and intentionally omits the `containers` section and the production custom domain routes.

For a local-first/static Worker deploy under a separate config, use:

```bash
pnpm deploy:cloudflare:local-first:dry-run
pnpm deploy:cloudflare:local-first
```

That explicit local-first path uses [wrangler.local-first.jsonc](wrangler.local-first.jsonc) and is not routed to the production custom domain.

For Cloudflare Builds, use:

```text
Build command: pnpm run build
Deploy command: npx wrangler deploy --config wrangler.containers.jsonc --containers-rollout=immediate
```

`pnpm deploy:cloudflare` is also valid as a deploy command. Do not use a web-assets-only, static, or local-first deploy command for the production Worker.

## Production Uptime

The live app runs at `https://cae.esau.app`. Uptime monitors should check the Worker health endpoint:

```bash
curl -fsS https://cae.esau.app/health
```

Solver readiness checks should use the Core Cloud health endpoint:

```bash
curl -fsS https://cae.esau.app/api/cloud-core/health
```

The `/health` route verifies the production Worker is reachable. The `/api/cloud-core/health` route verifies the bound OpenCAE Core Cloud service reports the expected solver, runner version, supported analysis types, and fail-closed production constraints.

## Workspace Layout

- `apps/opencae-web` - React/Vite CAD workspace for static and dynamic structural workflows.
- `apps/opencae-api` - Fastify API for projects, uploads, studies, jobs, artifacts, reports, and service orchestration.
- `../opencae-core/packages/*` - Live sibling OpenCAE Core packages consumed through the pnpm workspace.
- `libs/*` - Shared schema, units, materials, storage, jobs, diagnostics, validation, selection, result format, and service contracts.
- `services/*` - CAD, mesh, solver, post-processing, and legacy container reference implementations.
- `runners/opencae-runner-local` - Local runner package for job execution flows.
- `examples/*` - Sample project documentation and fixtures.
- `docs/*` - Architecture, local development, file format, validation, and user guide notes.
- `infra/local/*` - Local SQLite, storage, and jobs setup notes.
- `data/*` - Local runtime data directories for artifacts, logs, reports, uploads, and SQLite state.

## Simulation Flow

OpenCAE treats CAD entities as the source of truth. Meshes are generated artifacts, while results and reports are immutable study-run artifacts. Loads, supports, contacts, and named selections bind to CAD topology references so the data model can survive backend changes without rewriting the user workflow.

The built-in demos include bracket, beam, and cantilever studies with Aluminum 6061 and 3D-printing material presets, supports, payload/force loads, generated mesh summaries, and local report artifacts.

## Solver Attribution

Production solving is attributed to `OpenCAE Core Cloud`. Production results must carry `opencae_core_fea`, solver `opencae-core-cloud`, `computed` result provenance, and `actual_volume_mesh` or `structured_block_core` mesh provenance. Browser-local Core previews remain explicit development/demo behavior and must not be displayed as production FEA.

## Documentation

- [Architecture](docs/architecture/README.md)
- [Local development](docs/local-development/README.md)
- [User guide](docs/user-guide/README.md)
- [File format](docs/file-format/README.md)
- [Validation](docs/validation/README.md)

## License

OpenCAE source code is licensed under the Apache License 2.0.

OpenCAE may invoke or distribute separately licensed third-party tools and
libraries, including OCCT/occt-import-js components. Those
components are not relicensed under Apache-2.0. See [NOTICE](NOTICE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for details.

Copyright 2026 Esau Engineering. The OpenCAE name and logo are trademarks of Esau Engineering.

## Scope

OpenCAE is still an engineering preview. OpenCAE Core results are development-oriented analysis outputs and should not be treated as certified analysis. Native CAD, meshing, and post-processing support continue to evolve behind the existing service boundaries.
