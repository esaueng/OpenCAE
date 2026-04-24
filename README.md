# OpenCAE

OpenCAE is a local-first CAD/CAE simulation scaffold. This initial version is a Static Stress MVP with a dark CAD-like browser workspace, local API server, SQLite metadata, filesystem artifacts, local jobs, mock CAD/mesh/solver/post services, and a built-in Bracket Demo sample project.

## Local Development

```bash
pnpm install
pnpm dev
```

The dev command starts:

- API: `http://localhost:4317`
- Web: `http://localhost:5173`

The app can load the Bracket Demo without uploads. It shows a placeholder bracket model, guided setup steps, mock mesh generation, streamed mock solver progress, 3D stress results, and a local HTML report.

## Useful Commands

```bash
pnpm db:migrate
pnpm db:seed
pnpm reset:local
pnpm build
pnpm test
```

## Scope

This scaffold intentionally does not include real native CAD, meshing, or finite element solver integrations. CAD entities are modeled as the source of truth, mesh data is treated as generated artifacts, and results are immutable study-run artifacts.
