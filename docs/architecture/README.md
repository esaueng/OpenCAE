# OpenCAE Architecture

OpenCAE is organized around service boundaries that keep user workflow data separate from generated artifacts.

- The React/Vite web app owns the CAD workspace, study setup UI, local project save/open flow, result visualization, dynamic playback, and client-side modal phase animation.
- The Fastify API owns local projects, uploads, study mutation routes, validation, run orchestration, reports, and artifact lookup.
- SQLite stores project and study metadata through `@opencae/db`.
- Filesystem object storage stores geometry display models, uploaded model files, mesh summaries, solver inputs/logs, result bundles, HTML reports, and PDF reports under `data/artifacts`.
- The in-memory job queue and run-state provider publish run progress through Server-Sent Events for local development.
- CAD, mesh, OpenCAE Core solver, and post-processing services sit behind package boundaries so native implementations can evolve without changing study bindings.
- `@opencae/core`, `@opencae/solver-cpu`, and other OpenCAE Core packages resolve from this repo's `packages/*` workspace packages.

CAD entities remain the source of truth. Mesh entities are generated artifacts. Results and reports are immutable study-run artifacts. Loads, supports, contacts, and named selections bind to CAD topology references.

## Solver Boundaries

Static, dynamic, and modal structural studies run through OpenCAE Core with explicit attribution. The browser product limit is 100,000 DOF and is passed by `@opencae/solve-pipeline` into every solver call; callers must not rely on the solver package's lower internal default. Simple block or beam-like studies may use a structured proxy mesh and are labeled preview-only. Complex geometry is blocked from that path unless an actual connected Core volume mesh artifact is available, in which case the result can carry actual-volume-mesh FEA provenance.

Dynamic and modal analysis share sparse stiffness, constraint reduction, and positive HRZ lumped-mass assembly. Modal analysis uses deterministic block shift-invert subspace iteration and returns only modes that satisfy the scaled residual tolerance. Its normalized vector fields use the same deformation renderer as displacement, while the web app creates 24 phase frames without storing duplicate solver output.

## Materials And Workspace Sections

Starter materials and optional project-scoped custom materials resolve through `@opencae/materials`. The same strict resolver is used by UI assignment, study validation, mesh intake, browser/API Core adapters, and reports. An explicit dangling material ID is an error; no solver boundary substitutes a default material. Custom values are stored canonically in Pa and kg/m³, are marked user-supplied/unverified, and remain local to the owning project.

The open-section plane belongs to workspace UI state rather than the project model. Three.js local clipping is applied only below explicit geometry roots, including mesh/result materials and line-based feature/undeformed edges. Boundary-condition glyphs, probes, dimensions, and labels are separate scene branches and are not clipped. The WebGL `Open section` label is therefore present in viewer captures without becoming portable project data.
