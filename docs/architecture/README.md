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

## Run Variants And Linear Reuse

Structural load cases own only load membership. Geometry, supports, material, mesh, and solver settings remain on the study, so every case necessarily shares the same constrained system. Static case batches assemble and reduce `K` once, then use the preceding converged displacement as the next CG initial guess. Signed combinations superpose displacement, reaction, strain, and six-component stress tensors; von Mises and principal stress measures are recomputed afterward from the combined tensor.

Static envelopes keep pointwise maximum von Mises, the displacement vector from the variant with the largest nodal magnitude, and compact integer arrays that map each surface node to its governing case or combination. Run and variant ids both participate in field-selection, probe-topology, and packed-playback identities.

Dynamic cases reuse one K/M preparation and Rayleigh calibration but start each transient solve from independent zero displacement, velocity, and acceleration. The solve worker posts each completed case immediately. The web app writes each transient case to a separate IndexedDB record and retains only the active case payload in memory; cancellation or batch failure removes partial records.

## Static Mesh Convergence

Static convergence studies are project records, not run variants. The browser clones one selected load case and executes `coarse -> medium -> fine` through isolated mesh and solve jobs, leaving the working study's mesh and active results unchanged. Each generated mesh is preflighted through the Core adapter for actual node, element, total-DOF, and free-DOF counts before solving. The 100,000-DOF browser cap is imported from the lightweight `@opencae/solve-pipeline/limits` entry point and a capped rung is persisted as skipped instead of entering the worker.

The orchestrator retains only compact rung metrics: requested preset, actual mesh size and counts, raw element peak von Mises stress, and one interpolated displacement-probe magnitude. It reuses the result probe's barycentric vector interpolation on the nearest solver-surface triangle with a model-scale mapping tolerance. Full mesh and result fields remain transient to each worker job and are not attached to the convergence record.

## Materials And Workspace Sections

Starter materials and optional project-scoped custom materials resolve through `@opencae/materials`. The same strict resolver is used by UI assignment, study validation, mesh intake, browser/API Core adapters, and reports. An explicit dangling material ID is an error; no solver boundary substitutes a default material. Custom values are stored canonically in Pa and kg/m³, are marked user-supplied/unverified, and remain local to the owning project.

The open-section plane belongs to workspace UI state rather than the project model. Three.js local clipping is applied only below explicit geometry roots, including mesh/result materials and line-based feature/undeformed edges. Boundary-condition glyphs, probes, dimensions, and labels are separate scene branches and are not clipped. The WebGL `Open section` label is therefore present in viewer captures without becoming portable project data.
