# OpenCAE

OpenCAE is a local-first CAD/CAE simulation workspace. The current app includes static stress and dynamic structural studies, a browser CAD workspace, a local Fastify API, SQLite metadata, filesystem artifacts, local jobs, deterministic local solver services, Cloud FEA orchestration, and built-in sample projects.

The project is designed around service boundaries so local TypeScript services, browser workers, CAD import, meshing, solver, and post-processing backends can evolve independently.

## Local Development

Install dependencies and start the API and web app:

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts:

- API: `http://localhost:4317`
- Web: `http://localhost:5173`

The API creates and seeds the local SQLite database if needed. The web app can load the Bracket Demo without uploads, then walk through Model, Material, Supports, Loads, Mesh, Run, Results, and Report steps.

## Useful Commands

```bash
pnpm db:migrate
pnpm db:seed
pnpm reset:local
pnpm build
pnpm test
```

## Cloudflare Worker Deploy

The production Cloudflare target for `cae.esau.app` serves the Vite web app from Workers Static Assets. Cloudflare Builds should use the default deploy commands for Worker, asset, queue, and R2 updates without attempting a privileged container application rollout.

```bash
pnpm install
pnpm deploy:cloudflare:dry-run
pnpm deploy:cloudflare
```

Wrangler uses [wrangler.jsonc](wrangler.jsonc). The deploy builds `apps/opencae-web/dist`, serves it through the Worker asset binding, uses SPA fallback routing for browser routes, and binds R2 and Queues. This config intentionally omits the `containers` section and the `FEA_CONTAINER` Durable Object binding so Cloudflare Builds tokens that cannot update container applications still deploy successfully.

Container application rollouts require a token with Cloudflare Containers write access. Run that privileged deploy explicitly when the container image or app configuration changes:

```bash
pnpm deploy:cloudflare:containers
```

Real Cloud FEA transient animation requires that privileged container application deploy to have succeeded, because dynamic runs are rejected unless the container returns timed multi-frame result fields. The Cloud FEA container currently runs a CalculiX adapter for static and transient structural solves.

For a local-first/static Worker deploy without Cloud FEA containers, use:

```bash
pnpm deploy:cloudflare:local-first:dry-run
pnpm deploy:cloudflare:local-first
```

That explicit local-first path uses [wrangler.local-first.jsonc](wrangler.local-first.jsonc).

For Cloudflare Builds, set:

- Build command: `pnpm build:cloudflare`
- Deploy command: `npx wrangler deploy`

## Workspace Layout

- `apps/opencae-web` - React/Vite CAD workspace and static stress workflow.
- `apps/opencae-api` - Fastify API for projects, jobs, artifacts, and service orchestration.
- `libs/*` - Shared schema, units, materials, storage, jobs, diagnostics, and service contracts.
- `services/*` - CAD, mesh, solver, post-processing, and Cloud FEA container service implementations.
- `runners/opencae-runner-local` - Local runner package for job execution flows.
- `examples/*` - Sample project documentation and fixtures.
- `docs/*` - Architecture, local development, file format, validation, and user guide notes.
- `infra/local/*` - Local SQLite, storage, and jobs setup notes.
- `data/*` - Local runtime data directories for artifacts, logs, and reports.

## Simulation Flow

OpenCAE treats CAD entities as the source of truth. Meshes are generated artifacts, while results and reports are immutable study-run artifacts. Loads, supports, contacts, and named selections bind to CAD topology references so the data model can survive backend changes without rewriting the user workflow.

The built-in demos include bracket, beam, and cantilever studies with Aluminum 6061 and 3D-printing material presets, supports, payload/force loads, generated mesh summaries, stress/displacement/safety-factor results, dynamic playback where available, and local report artifacts.

## Solver Attribution

OpenCAE uses two solver paths:

- **Detailed local solver** - a deterministic TypeScript structural solver in `@opencae/solver-service` for fast local/browser estimates, static stress, dynamic structural playback, and responsive demo workflows.
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

OpenCAE is still an engineering preview. Local results are fast estimates for product workflow development and should not be treated as certified analysis. The Cloud FEA path provides a CalculiX-backed integration point for higher-fidelity solver work, while native CAD, meshing, and post-processing support continue to evolve behind the existing service boundaries.
