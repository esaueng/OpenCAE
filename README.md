# OpenCAE

OpenCAE is a local-first CAD/CAE simulation workspace for structural study setup, fast local solves, and browser-based result review. The current app supports static stress and dynamic structural studies, sample projects, local project files, uploaded geometry previews, browser-local OpenCAE Core CPU solves, deterministic Detailed local fallback paths, and report export.

The project is organized around service boundaries so the React workspace, Fastify API, CAD import, meshing, browser/local solvers, legacy container reference code, post-processing, storage, and job runners can evolve independently.

## Local Development

Install dependencies and start the API and web app:

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

The production Cloudflare target for `cae.esau.app` serves the Vite web app from Workers Static Assets. The default deploy path builds the web app, deploys the Worker asset binding, enables SPA fallback routing, and does not require `FEA_CONTAINER` or `@cloudflare/containers`. Simulations run in the browser through OpenCAE Core CPU Tet4 where eligible, with Detailed local fallback for unsupported cases.

```bash
pnpm install
pnpm deploy:cloudflare
```

Wrangler uses [wrangler.jsonc](wrangler.jsonc) for the production app domain by default. That config intentionally omits container bindings and returns a local-first API message for `/api/*` routes because the browser app owns simulation execution.

The legacy container config remains available for reference and manual experiments:

```bash
pnpm deploy:cloudflare:containers:dry-run
pnpm deploy:cloudflare:containers
```

For a separate static Worker deploy, use:

```bash
pnpm deploy:cloudflare:static:dry-run
pnpm deploy:cloudflare:static
```

That static path uses [wrangler.static.jsonc](wrangler.static.jsonc), which targets `opencae-static` and intentionally omits the `containers` section and the production custom domain route.

For a local-first/static Worker deploy under a separate config, use:

```bash
pnpm deploy:cloudflare:local-first:dry-run
pnpm deploy:cloudflare:local-first
```

That explicit local-first path uses [wrangler.local-first.jsonc](wrangler.local-first.jsonc).

For Cloudflare Builds, use:

```bash
Build command: pnpm run build
Deploy command: npx wrangler deploy
```

`pnpm deploy:cloudflare` is also valid as a deploy command, but do not use a web-assets-only deploy command for the production Worker.

## Workspace Layout

- `apps/opencae-web` - React/Vite CAD workspace for static and dynamic structural workflows.
- `apps/opencae-api` - Fastify API for projects, uploads, studies, jobs, artifacts, reports, and service orchestration.
- `libs/*` - Shared schema, units, materials, storage, jobs, diagnostics, validation, selection, result format, and service contracts.
- `services/*` - CAD, mesh, solver, post-processing, and legacy container reference implementations.
- `runners/opencae-runner-local` - Local runner package for job execution flows.
- `examples/*` - Sample project documentation and fixtures.
- `docs/*` - Architecture, local development, file format, validation, and user guide notes.
- `infra/local/*` - Local SQLite, storage, and jobs setup notes.
- `data/*` - Local runtime data directories for artifacts, logs, reports, uploads, and SQLite state.

## Simulation Flow

OpenCAE treats CAD entities as the source of truth. Meshes are generated artifacts, while results and reports are immutable study-run artifacts. Loads, supports, contacts, and named selections bind to CAD topology references so the data model can survive backend changes without rewriting the user workflow.

The built-in demos include bracket, beam, and cantilever studies with Aluminum 6061 and 3D-printing material presets, supports, payload/force loads, generated mesh summaries, stress/displacement/safety-factor results, dynamic playback where available, and local report artifacts.

## Solver Attribution

OpenCAE uses two solver families:

- **OpenCAE Core browser solver** - vendored `@opencae/core` and `@opencae/solver-cpu` packages run eligible static stress studies in the web worker using a small Tet4 CPU model. Results are marked with `opencae_core_fea`, `opencae_core_tet4`, and `computed` provenance.
- **Detailed local solver** - deterministic TypeScript local solvers in `@opencae/solver-service`. Static studies use a heuristic surface-response path, the Beam Demo can use an Euler-Bernoulli beam path, and dynamic studies use Newmark average-acceleration integration for transient playback frames.

Legacy CalculiX/Gmsh container code remains under `services/opencae-fea-container` for reference. It is not part of the default browser or production Worker runtime.

## Documentation

- [Architecture](docs/architecture/README.md)
- [Local development](docs/local-development/README.md)
- [User guide](docs/user-guide/README.md)
- [File format](docs/file-format/README.md)
- [Validation](docs/validation/README.md)

## License

OpenCAE source code is licensed under the Apache License 2.0.

OpenCAE may invoke or distribute separately licensed third-party tools and
libraries, including CalculiX, Gmsh, and OCCT/occt-import-js components. Those
components are not relicensed under Apache-2.0. See [NOTICE](NOTICE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for details.

Copyright 2026 Esau Engineering. The OpenCAE name and logo are trademarks of Esau Engineering.

## Scope

OpenCAE is still an engineering preview. Browser OpenCAE Core and Detailed local results are development-oriented analysis outputs and should not be treated as certified analysis. Native CAD, meshing, and post-processing support continue to evolve behind the existing service boundaries.
