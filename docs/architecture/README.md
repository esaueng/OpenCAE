# OpenCAE Architecture

OpenCAE is organized around service boundaries that keep user workflow data separate from generated artifacts.

- The React/Vite web app owns the CAD workspace, study setup UI, local project save/open flow, result visualization, and dynamic playback.
- The Fastify API owns local projects, uploads, study mutation routes, validation, run orchestration, reports, and artifact lookup.
- SQLite stores project and study metadata through `@opencae/db`.
- Filesystem object storage stores geometry display models, uploaded model files, mesh summaries, solver inputs/logs, result bundles, HTML reports, and PDF reports under `data/artifacts`.
- The in-memory job queue and run-state provider publish run progress through Server-Sent Events for local development.
- CAD, mesh, OpenCAE Core solver, and post-processing services sit behind package boundaries so native implementations can evolve without changing study bindings.
- `@opencae/core`, `@opencae/solver-cpu`, and other OpenCAE Core packages resolve from the sibling `../opencae-core` workspace instead of vendored package copies in this repo.

CAD entities remain the source of truth. Mesh entities are generated artifacts. Results and reports are immutable study-run artifacts. Loads, supports, contacts, and named selections bind to CAD topology references.

## Solver Boundaries

Static and dynamic structural studies run through OpenCAE Core. The `@opencae/solver-cpu` package adapts study data to a Tet4 CPU model, emits computed Core provenance, and writes timed dynamic result frames for playback.
