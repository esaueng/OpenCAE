# OpenCAE

OpenCAE is a local-first CAD/CAE simulation workspace for structural study setup, fast local solves, and browser-based result review. The current app supports static stress and dynamic structural studies, sample projects, local project files, uploaded geometry previews, deterministic local solver paths, Cloud FEA orchestration, and report export.

The project is organized around service boundaries so the React workspace, Fastify API, CAD import, meshing, local solvers, Cloud FEA containers, post-processing, storage, and job runners can evolve independently.

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

The production Cloudflare target for `cae.esau.app` serves the Vite web app from Workers Static Assets. The default deploy path builds the web app, deploys the Worker asset binding, enables SPA fallback routing, binds R2 and Queues, and binds the Cloud FEA container application through `FEA_CONTAINER`.

```bash
pnpm install
pnpm deploy:cloudflare
```

Wrangler uses [wrangler.containers.jsonc](wrangler.containers.jsonc) for the production app domain by default. It is intentionally kept container-bound so Cloudflare Builds or plain Wrangler deploys for Worker `opencae` cannot drop `FEA_CONTAINER`. [wrangler.jsonc](wrangler.jsonc) is kept as the same production container-bound config. Both production configs point `containers[0].image` at `./services/opencae-fea-container/Dockerfile`, so `wrangler deploy` builds and pushes the current container image before rollout. Cloud FEA browser calls stay on the app domain at `/api/cloud-fea/*`; the Worker reaches the container through the `FEA_CONTAINER` binding.

Do not change production `wrangler.jsonc` to a non-container Worker. The production Worker name is `opencae`, and every deploy to that Worker must include `FEA_CONTAINER`.

After production deploy, `https://cae.esau.app/api/cloud-fea/health` must report `containerBound=true`.

Container application rollouts require a token with Cloudflare Containers write access. The explicit container deploy scripts are kept as aliases for the default production deploy path:

```bash
pnpm deploy:cloudflare:containers:dry-run
pnpm deploy:cloudflare:containers
```

Real Cloud FEA transient animation requires a successful container deploy because dynamic Cloud FEA runs are rejected unless the container returns timed multi-frame result fields. The Cloud FEA container generates CalculiX input decks and uses the open-source CalculiX CrunchiX executable (`ccx`) for static and transient structural solves when the container runtime is available.

Changing `services/opencae-fea-container/runner.py` requires redeploying the container-enabled Worker with `pnpm deploy:cloudflare` or `npx wrangler deploy`; rebuilding or deploying web assets alone will not update the Cloud FEA runner image. Do not replace the production Dockerfile image path with a registry tag unless the deploy command first builds and pushes that exact tag.

For a static Worker deploy without Cloud FEA containers, use the explicit static path:

```bash
pnpm deploy:cloudflare:static:dry-run
pnpm deploy:cloudflare:static
```

That static path uses [wrangler.static.jsonc](wrangler.static.jsonc), which targets `opencae-static` and intentionally omits the `containers` section, the production custom domain route, and the `FEA_CONTAINER` Durable Object binding. It must not be attached to `cae.esau.app`; static deployments should use the Detailed local backend.

For a local-first/static Worker deploy without Cloud FEA containers, use:

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
- `services/*` - CAD, mesh, solver, post-processing, and Cloud FEA container service implementations.
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

- **Detailed local solver** - deterministic TypeScript local solvers in `@opencae/solver-service`. Static studies use a heuristic surface-response path, the Beam Demo can use an Euler-Bernoulli beam path, and dynamic studies use Newmark average-acceleration integration for transient playback frames.
- **Cloud FEA solver** - a containerized adapter in `services/opencae-fea-container` that generates CalculiX input decks and runs the open-source **CalculiX CrunchiX** executable (`ccx`) when Cloud FEA containers are enabled. The container image installs Debian's `calculix-ccx` package and also includes **Gmsh** for uploaded geometry meshing/staging. CalculiX and Gmsh are separately licensed third-party components and are not relicensed under Apache-2.0.

Credit: [CalculiX](http://www.calculix.de/) provides the open-source finite element solver used by the Cloud FEA path. [Gmsh](https://gmsh.info/) is used as the open-source meshing tool in the Cloud FEA container when uploaded geometry needs a generated mesh.

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

OpenCAE is still an engineering preview. Local results are deterministic estimates for product workflow development and should not be treated as certified analysis. The Cloud FEA path provides a CalculiX-backed integration point for higher-fidelity solver work, while native CAD, meshing, and post-processing support continue to evolve behind the existing service boundaries.
