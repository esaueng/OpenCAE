# OpenCAE

OpenCAE is a local-first CAD/CAE simulation scaffold. The current workspace is a Static Stress MVP with a browser CAD workspace, a local Fastify API, SQLite metadata, filesystem artifacts, local jobs, mock CAD/mesh/solver/post services, and built-in sample projects.

The scaffold is designed around service boundaries that can start as TypeScript mocks and later move to native CAD kernels, meshing tools, solvers, and post-processing services.

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

The Cloudflare target serves the Vite web app from Workers Static Assets. It is intentionally local-first: API-backed actions return a JSON 503 from the Worker so the web client uses its browser-local fallback behavior.

```bash
pnpm install
pnpm deploy:cloudflare:dry-run
pnpm deploy:cloudflare
```

Wrangler uses [wrangler.jsonc](wrangler.jsonc). The deploy builds `apps/opencae-web/dist`, serves it through the Worker asset binding, and uses SPA fallback routing for browser routes.

## Workspace Layout

- `apps/opencae-web` - React/Vite CAD workspace and static stress workflow.
- `apps/opencae-api` - Fastify API for projects, jobs, artifacts, and service orchestration.
- `libs/*` - Shared schema, units, materials, storage, jobs, diagnostics, and service contracts.
- `services/*` - Mock CAD, mesh, solver, and post-processing service implementations.
- `runners/opencae-runner-local` - Local runner package for job execution flows.
- `examples/*` - Sample project documentation and fixtures.
- `docs/*` - Architecture, local development, file format, validation, and user guide notes.
- `infra/local/*` - Local SQLite, storage, and jobs setup notes.
- `data/*` - Local runtime data directories for artifacts, logs, and reports.

## Simulation Flow

The MVP treats CAD entities as the source of truth. Meshes are generated artifacts, while results and reports are immutable study-run artifacts. Loads, supports, contacts, and named selections bind to CAD topology references so the data model can survive future swaps from mocks to real geometry and solver backends.

The current Bracket Demo includes a placeholder bracket body, Aluminum 6061 material, one fixed support, one load, mock mesh data, mock stress and displacement results, and a generated local report.

## Documentation

- [Architecture](docs/architecture/README.md)
- [Local development](docs/local-development/README.md)
- [User guide](docs/user-guide/README.md)
- [File format](docs/file-format/README.md)
- [Validation](docs/validation/README.md)

## Scope

This scaffold intentionally does not include real native CAD, meshing, or finite element solver integrations yet. The service contracts and workspace boundaries are in place so those integrations can be added without rewriting the user workflow.
