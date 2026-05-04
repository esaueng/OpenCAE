# OpenCAE Architecture

OpenCAE is organized around service boundaries that keep user workflow data separate from generated artifacts.

- The React/Vite web app owns the CAD workspace, study setup UI, local project save/open flow, result visualization, and dynamic playback.
- The Fastify API owns local projects, uploads, study mutation routes, validation, run orchestration, reports, and artifact lookup.
- SQLite stores project and study metadata through `@opencae/db`.
- Filesystem object storage stores geometry display models, uploaded model files, mesh summaries, solver inputs/logs, result bundles, HTML reports, and PDF reports under `data/artifacts`.
- The in-memory job queue and run-state provider publish run progress through Server-Sent Events for local development.
- CAD, mesh, solver, and post-processing services sit behind package boundaries so native or external implementations can replace local implementations without changing study bindings.

CAD entities remain the source of truth. Mesh entities are generated artifacts. Results and reports are immutable study-run artifacts. Loads, supports, contacts, and named selections bind to CAD topology references.

## Solver Boundaries

Local static studies run through deterministic TypeScript solver paths. General static studies use a heuristic surface-response model, while the Beam Demo can use a 1D Euler-Bernoulli path. Dynamic structural studies use Newmark average-acceleration integration and write timed result frames for playback.

The Cloud FEA path is isolated in `services/opencae-fea-container`. When deployed with the required Cloudflare Containers privileges, it generates CalculiX input decks and returns static or transient structural result fields through the Worker orchestration layer.
