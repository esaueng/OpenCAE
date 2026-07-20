# 024 — Codebase Health and Solver Capability Roadmap

## Status

Proposed on 2026-07-19 against `main` at `2b99086`. No implementation has started.

This roadmap addresses the July codebase review without treating stale observations as current facts. It is a release train, not one large change: every increment must remain independently buildable, reviewable, and reversible. Numerical behavior, units, file formats, solver defaults, and product limits must not change unless that increment names and verifies the change.

## Reconciled baseline

| Review item | Current repository evidence | Planning decision |
| - | - | - |
| CG “relative” tolerance uses a unit-sensitive floor | Confirmed: `packages/solver-cpu/src/sparse.ts` divides by `max(norm(rhs), 1)`, and `solver.ts` uses the same floor in a residual diagnostic. | Fix first and add scaled-load invariance tests. |
| Solver limits disagree and dynamic direct calls are unguarded | Partially confirmed, but the cited numbers are stale. Static and browser limits are now 150,000 DOF; modal still owns a 30,000 default; `solveCoreDynamic` has no package-level DOF guard. | Give `solver-cpu` one authoritative default/cap contract and guard every public entry point. Keep modal projection behavior explicit. |
| Only Jacobi CG exists and `solver-wasm` is the obvious acceleration path | Stale. SSOR is implemented and tested, and `packages/solver-webgpu` contains a real matrix-free Tet4 path used by `@opencae/core-adapter`. `packages/solver-wasm` is still a one-line stub. | Benchmark and tune the implementations that exist before adding IC(0). Remove the unused WASM solver stub; do not delete WebGPU. |
| Five empty libraries are dead code | The directories contain only ignored `node_modules` folders and no tracked source or manifests. | No repository deletion is required; a clean install removes the local remnants. |
| `packages/viewer` and `packages/solver-webgpu` are orphaned | `solver-webgpu` is live. `packages/viewer` is not imported by the app, but it contains a tested solver-surface conversion seam suitable for adoption during viewer decomposition. | Retain WebGPU; adopt `@opencae/viewer` in the app or delete it only if parity tests prove the app has a better canonical implementation. |
| Legacy backend is undeployed and duplicates production behavior | Confirmed and larger than the review estimate: API/services/jobs/storage total about 6,630 TypeScript source lines. The production Worker rejects these APIs while the browser still tries them and then falls back locally. | Retire the server-first fallback and backend stack after a route-by-route parity inventory. Keep encrypted Worker backups, which are live production behavior. |
| Three UI files are growing into change hotspots | Confirmed: `CadViewer.tsx` 7,301 lines, `WorkspaceApp.tsx` 2,994, and `RightPanel.tsx` 2,908 at this baseline. | Decompose incrementally behind existing behavior tests; do not mix extraction with visual redesign. |
| CI misses the production build and bundle budget | Confirmed. The web package owns `check:bundle`, but CI stops after typecheck/tests. | Execute plan 008 as an early release gate and update it for the final retained package list. |
| Frontend and other dependencies are behind | Confirmed by `pnpm outdated --recursive` on 2026-07-19. Backend-only Fastify and SQLite upgrades may disappear with backend retirement. | Upgrade by compatibility cohort after cleanup; never combine schema, mesher, renderer, and compiler majors. |

## Program invariants

- Preserve Z-up coordinates and the current canonical unit contracts. Every new exported file must declare coordinate and field units.
- Use epsilon or scale-aware comparisons for computed floats. Exact comparisons remain allowed only for discrete counts, sentinels, and values assigned exactly by the algorithm.
- Treat the current 150,000 browser DOF ceiling as a product limit. Six-DOF shell/beam nodes count as six DOFs, not three.
- Keep Tet4/Tet10 static, dynamic, modal, thermal, load-case, report, project-file, and result-field compatibility unless a versioned migration is included.
- Solver capability is development-grade until analytical benchmarks, mesh refinement evidence, equilibrium checks, and real browser execution pass.
- Do not hide approximations: modal truncation, linear buckling, shell drilling stabilization, beam shear assumptions, and selected-frame exports must be labeled in UI, diagnostics, and reports.
- Each increment uses focused tests plus `pnpm typecheck` and `pnpm build`. Run the full monorepo suite only when the maintainer explicitly requests it.

## Release 1 — Numerical correctness and bounded public solvers

### 1A. Make CG convergence truly relative

- Replace `max(norm(rhs), 1)` with a scale-safe reference. For a zero right-hand side, use the initial residual norm when an initial guess exists and return the exact zero solution immediately when both are zero.
- Apply the same residual definition to `residualDiagnostics` so convergence diagnostics and solver termination cannot disagree.
- Preserve both absolute residual norm and dimensionless relative residual in diagnostics.
- Add regression tests that solve the same SPD system with load scales `1e-9`, `1`, and `1e9`; normalized solutions, iteration outcome, and relative residual must agree within explicit tolerances.
- Add zero-RHS, nonzero-initial-guess, cancellation, and near-singular-preconditioner cases.

Acceptance: changing only the force-unit scale cannot change pass/fail convergence or the normalized displacement solution.

### 1B. Unify DOF limits and guard all entry points

- Define the solver-owned default structural DOF cap in `packages/solver-cpu` and import it wherever static, dynamic, modal, and WebGPU entry points need the same default. Keep browser policy in `@opencae/solve-pipeline`, but derive its CPU ceiling from that exported contract instead of duplicating a number.
- Add a common `structuralDofCount(model)` helper. Keep thermal's scalar-temperature DOF count separate and label it accordingly.
- Fail before stiffness/mass allocation in `solveCoreStatic`, `solveCoreDynamic`, `solveCoreModal`, batch static/dynamic variants, and direct lower-level public functions.
- Preserve the intentional Tet10-to-Tet4 modal projection. Diagnostics must report both source DOFs and solved/projected DOFs and state which count the cap applies to.
- Add direct-call tests proving no public route can allocate above its cap, including callers that bypass the browser pipeline.

Acceptance: every public solve path rejects an over-limit model with the same typed error family before matrix assembly.

### 1C. Run the production build and bundle budget in CI

- Execute the existing plan `008-ci-build-web-and-enforce-bundle-budget.md`, updated to call `pnpm build:cloudflare` and `pnpm --filter @opencae/web check:bundle` after typecheck.
- Remove retired package builds from both `build:core` and CI only in the same commit that removes those packages.
- Keep the Cloudflare config verification before the production build and retain build artifacts only when useful for diagnosing failures.

Acceptance: CI catches Vite production-build failures and bundle-budget regressions before deploy.

### 1D. Replace scattered magic numbers with dimensional tolerance policies

- Do not create one global epsilon. Add small domain-owned policy modules for sparse algebra, element geometry/Jacobians, load equilibrium, topology/selection mapping, and time integration.
- Name every threshold by intent and document whether it is absolute, relative, machine-precision-derived, or scaled by model length/matrix/tensor magnitude.
- Replace `Number.MIN_VALUE` sparse drop semantics with an explicitly named exact-underflow policy or a scale-aware assembly drop rule backed by symmetry and equilibrium tests.
- Add tests at millimeter/MPa and meter/Pa representations of equivalent models. Geometry validity, load balance, and result classification must agree after unit conversion.
- Change tolerances in small domain commits; do not perform a mechanical repository-wide replacement.

Acceptance: the same physical model expressed in both supported internal unit systems reaches the same validation/solve decisions within documented numeric error.

## Release 2 — Raw result export

- Add a pure export model under `apps/opencae-web/src/report/` that consumes the active `CoreSolveResult`/browser result contract without recomputing fields.
- Ship CSV and VTK XML UnstructuredGrid (`.vtu`) for the active result variant and selected static frame, dynamic frame, modal mode, or later harmonic frequency.
- CSV must include stable node/element identifiers, canonical coordinates/connectivity, field location, component names, and units. VTU `FieldData` must record OpenCAE schema version, analysis type, coordinate system (`Z-up`), length units, field units, variant, and frame/mode/frequency identity.
- Export canonical solver values by default. If display-unit export is offered, make it an explicit choice and encode the chosen units in headers and filenames.
- Generate output in bounded chunks and save through the existing `prepareBlobSaveToDisk` seam. Preflight estimated output size and refuse a request that would exceed a documented browser-memory budget.
- Label v1 honestly as selected-state export. Do not imply that one VTU contains a whole transient series. A later archive/streaming increment may add all-frame export after memory profiling.
- Add fixtures that re-read CSV and VTU, verify counts/connectivity/components/units, and compare numeric values to the originating result. Smoke-open representative VTU files in ParaView before release.

Acceptance: an engineer can export the currently viewed raw fields without screenshots, unit ambiguity, field recomputation, or silent truncation.

## Release 3 — Retire undeployed backend and proven dead code

### 3A. Remove server-first browser fallbacks

- Inventory every `fetchJsonWithFallback` route and prove its local fallback preserves the production behavior for create/import/upload, study edits, meshing, reports, runs, cancellation, and result persistence.
- Replace fetch-first APIs with direct browser-local functions. Production must stop generating expected `/api/*` 404s, and local development must use the same execution path as deployment.
- Keep `/api/project-backups/*` on the Cloudflare Worker; it is encrypted recovery infrastructure, not part of the retired local API.
- Add browser characterization for create, open, save, reload, upload, mesh, solve, cancel, results, report, and encrypted-backup preference before removing the server path.

### 3B. Delete the backend slice atomically

- Remove `apps/opencae-api`, the four API-only services, `libs/opencae-jobs`, `libs/opencae-storage`, and `runners/opencae-runner-local` after route parity passes.
- Split browser-safe sample fixtures out of `@opencae/db`; then remove SQLite/runtime database code and `better-sqlite3` if no retained tool imports them.
- Remove API/database root scripts, backend dependencies, workspace entries if narrowed globs are preferable, docs, and obsolete tests in the same increment.
- Retain `services/legacy-calculix-container/README.md` only if the quarantine guard still needs an explicit tombstone; otherwise replace the path-based guard with a repository-wide forbidden-import/config assertion and remove the directory.
- Delete `packages/solver-wasm` after updating architecture docs. Gmsh WASM meshing is a different, live subsystem and must remain.
- Adopt `@opencae/viewer` during Release 5 or delete it after behavior-equivalence tests. Do not leave it indefinitely in an ambiguous state.
- Remove the unused `formatEngineeringValue` export and disabled worker source files only after `rg`, TypeScript, Vite, and worker build checks prove no generated/config alias consumes them.

Acceptance: `pnpm dev` runs the production-equivalent web path, no retained package depends on the removed backend, and build/typecheck/targeted browser flows pass from a clean install.

## Release 4 — Measure and improve the linear solver core

- Add a repeatable benchmark harness at representative free-DOF bands (about 30k, 75k, and 150k) with well-conditioned and ill-conditioned meshes. Record assembly time, solve time, iterations, peak memory, residual, and displacement/reaction parity.
- Compare existing Jacobi CG, SSOR CG across a bounded omega sweep, and the current automatic WebGPU Tet4 path. Include Tet10 CPU behavior and browser Chromium/WebKit runs.
- Make the best existing preconditioner the default only if benchmarks show a consistent win without material memory or accuracy regression. Store the selected preconditioner and parameters in diagnostics.
- Add IC(0) only if Jacobi/SSOR still miss the agreed performance target. Use a symmetric sparsity-preserving factorization with positive-pivot checks, a deterministic fallback to SSOR/Jacobi, and explicit factor-memory accounting.
- Keep the iteration cap bounded independently of `rows * 20`; derive it from a named product policy and report exhaustion clearly.
- Do not create a new WASM kernel by assumption. A native/WASM kernel becomes a separate proposal only after profiling proves JavaScript arithmetic, rather than assembly, memory traffic, meshing, or rendering, is the dominant cost.

Acceptance: the 150k-DOF supported case has a documented browser runtime/memory envelope, stable numerical parity, and a deterministic fallback when acceleration is unavailable.

## Release 5 — Modernize dependencies and decompose the UI

### 5A. Upgrade by compatibility cohort

1. After backend retirement, remove obsolete Fastify, plugin, and SQLite upgrade work rather than updating code scheduled for deletion.
2. Upgrade React 18 to 19 together with React DOM, `@react-three/fiber` 8 to 9, drei 9 to 10, Three 0.171 to 0.185, matching type packages, and the React Vite plugin. Keep Vite itself in this cohort only if its migration errors overlap; otherwise land it separately.
3. Upgrade Vite 6 to 8 and Vitest 3 to 4 as a tooling cohort with production build, PWA/offline, worker, and browser-startup checks.
4. Upgrade Zod 3 to 4 alone. Exercise parse/migration/error-shape tests across the schema hub before changing any schema behavior.
5. Upgrade `@loumalouomega/gmsh-wasm` 0.1.2 to 0.2.0 alone. Re-run mesh golden counts/quality, STEP repair/fallback, offline precache, and real uploaded-CAD browser meshing.
6. Upgrade jsPDF, Wrangler, and other leaf/tool packages in separate low-coupling commits. Verify PDF pixel/layout fixtures and Cloudflare dry-run respectively.
7. Evaluate TypeScript 7 separately; do not bundle a native-compiler/toolchain migration into routine dependency updates.

Each cohort begins with an updated `pnpm outdated --recursive` snapshot because registry state is time-sensitive.

### 5B. Decompose without behavior changes

- `WorkspaceApp.tsx`: extract run/mesh orchestration, project persistence/recent files, result/report export, and workspace UI-state hooks. Keep one owner for each async generation token and cancellation guard.
- `RightPanel.tsx`: extract one typed panel per workflow step plus results/modal/thermal panels. Keep navigation and shared study mutations in a small coordinator.
- `CadViewer.tsx`: first extract solver-surface conversion through `@opencae/viewer`, then overlays/annotations, result coloring/deformation, camera controls, clipping, and capture plumbing. Preserve one render-loop owner per responsibility and reuse allocated vectors.
- Add characterization tests and screenshot/browser checks before each extraction. Do not restyle, rename user-facing copy, or change routing/state during decomposition.
- Set reviewable size goals, not arbitrary line-count gates: no newly extracted module should mix persistence, solver orchestration, and rendering responsibilities.

Acceptance: every existing workflow and visual baseline is unchanged while future feature commits no longer require simultaneous edits to all three hotspot files.

## Release 6 — Harmonic frequency response by modal superposition

- Add a versioned `harmonic_response` study/step with frequency range, linear/log sampling, damping ratio or explicit Rayleigh coefficients, excitation case, requested mode count, and response probes.
- Use modal superposition for v1: project the load into mass-normalized modes and solve each scalar complex modal response. Do not force the real SPD CG solver to solve a complex indefinite system.
- Report mode coverage, highest retained natural frequency, effective/modal mass participation, damping model, and a truncation warning when the requested sweep exceeds justified modal coverage.
- Return compact response curves for explicit probes and selected summary metrics. Materialize full amplitude/phase surface fields only for the selected frequency and cache them by frequency/mode basis identity.
- Visualize amplitude and phase separately; any animated oscillation is visualization-only and must state its scale and phase convention.
- Validate against closed-form damped SDOF and two-DOF systems, resonance location/amplitude, low-frequency static limit, modal orthogonality, and load/direction scaling. Add one browser cantilever sweep.

Acceptance: response curves and selected-frequency fields match analytical systems within documented tolerance and never imply completeness beyond the retained mode basis.

## Release 7 — Linear eigenvalue buckling

- Add a `linear_buckling` study tied to one static preload case and requested mode count. The result is a linear bifurcation load factor, not a nonlinear collapse or safety factor.
- Reuse static displacement/stress as the preload state, assemble element geometric stiffness consistently for Tet4/Tet10, and solve the generalized eigenproblem with a deterministic shift-invert/subspace method derived from modal infrastructure.
- Return positive finite load factors sorted ascending, normalized buckling shapes, scaled eigen residuals, and diagnostics for negative/near-zero factors, rigid modes, inadequate constraints, and non-convergence.
- Show critical factor, critical applied load, mode table, and visualization-only normalized shapes. Reports must warn that imperfections, plasticity, contact, and post-buckling are excluded.
- Validate an Euler column in multiple orientations, a plate benchmark, sign reversal of tensile/compressive preload, load-scaling reciprocity, mesh refinement, and equilibrium of the preload solution.

Acceptance: critical factors converge toward analytical/accepted benchmark values and rotate/scale correctly without coordinate- or unit-dependent behavior.

## Release 8 — Shell elements, then beam elements

Shells and beams are separate releases because they introduce six-DOF nodes, local frames, section properties, new meshing workflows, and new result semantics. Do not advertise them together before both pass their own gates.

### 8A. Generalize the structural system

- Version Core element blocks and DOF maps to support translational-only solid nodes and translational-plus-rotational structural nodes without assuming `node * 3` indexing.
- Generalize constraints, loads, sparse assembly, mass, reactions, result recovery, DOF preflight, and surface/line visualization. Initially reject unsupported mixed solid/shell/beam coupling instead of silently sharing incompatible node DOFs.
- Define local coordinate frames with robust normalization, handedness checks, and scale-aware degeneracy errors. Preserve global Z-up and export both local and global result conventions.

### 8B. Triangular thin-shell v1

- Implement a documented linear triangular shell formulation using a constant-strain membrane plus a well-known discrete-Kirchhoff bending formulation, with explicit drilling-rotation stabilization and thickness/density/material section data.
- Scope v1 to explicit midsurface geometry or user-selected analysis surfaces with assigned thickness. Do not infer a midsurface automatically from a closed solid.
- Support pressure/traction, gravity/inertia, fixed and component constraints, static, modal, and later buckling/harmonic reuse. Reject unsupported offsets, laminates, nonlinear behavior, and ambiguous normals.
- Recover membrane forces, bending moments, transverse shear where meaningful, top/bottom surface stresses, von Mises, displacement, and rotations with stated sign conventions.
- Validate membrane and bending patch tests, rigid-body modes, cantilever plate, simply supported plate, a standard curved-shell benchmark, orientation reversal, thickness scaling, and mesh convergence.

Acceptance: patch tests pass, benchmark convergence is documented, top/bottom stress signs are stable under local-frame transformations, and the UI never treats a closed solid skin as an automatic shell midsurface.

### 8C. Two-node Timoshenko beam v1

- Implement a 3D two-node Timoshenko beam with six DOFs per node, robust local orientation, area, torsion constant, shear areas, and principal second moments. Use selective/reduced integration or another documented treatment of slender-beam shear locking.
- Scope v1 to explicit line/centerline geometry and a project section library. Do not guess centerlines or section properties from arbitrary solids.
- Support axial force, shear, torsion, distributed/point loads, gravity/inertia, static, modal, and reuse in buckling/harmonic after base validation.
- Recover axial/shear forces, torsion, bending moments, displacement, rotation, and clearly labeled section stress extrema. Preserve the distinction between resultants and point stresses.
- Validate axial, torsion, local-y/local-z bending, Euler-Bernoulli slender limit, deep-beam Timoshenko response, first natural frequency, Euler buckling reuse, orientation invariance, and mesh convergence.

Acceptance: all fundamental load modes match closed-form solutions within documented tolerances and section orientation cannot silently flip between save, solve, export, and reload.

## Delivery order and dependencies

1. Releases 1A–1C: correctness, limits, and CI. These are immediate blockers for every later solver feature.
2. Release 2: selected-state CSV/VTU export, an independent high-demand win.
3. Release 1D: tolerance policy migration in small domain commits.
4. Release 3: backend/stub retirement, removing alternate behavior before new schemas and studies multiply it.
5. Release 4: benchmark/tune the existing CPU and WebGPU solver paths.
6. Release 5A: dependency cohorts; browser characterization must stay green after each cohort.
7. Release 5B: hotspot decomposition, with only the minimum extraction needed by each following feature.
8. Release 6: harmonic response.
9. Release 7: linear buckling.
10. Release 8A, 8B, 8C: structural DOF generalization, shells, then beams.

Harmonic and buckling may share schema/eigensolver primitives, but neither should wait for shell/beam support. Once shells/beams land, extend those studies to new element types only after their static/modal validations pass.

## Commit and release discipline

- Commit each numbered increment directly to the current branch with a short imperative message; push after its gates pass.
- Never combine dependency majors, numeric-policy changes, package deletion, component extraction, or a new analysis type in one commit.
- For file-format/schema changes, add backward-reading fixtures before writing the new form and document the version/migration in `docs/core/` and the product README.
- For solver changes, retain benchmark inputs and expected values in the repository. Record formula source, units, coordinate frame, tolerance, mesh level, and acceptable error.
- For UI work, verify a real rendered flow at desktop and narrow viewport, check console/runtime health, and confirm save/reload persistence where the feature stores state.

## Definition of done

The review is fully addressed only when:

- relative convergence and every DOF guard are numerically verified;
- CI builds the production bundle and enforces its budget;
- selected raw results export with explicit units and topology;
- the undeployed backend and true stubs are removed without losing production behavior;
- solver performance is measured and improved using evidence, not a presumed kernel rewrite;
- the dependency cohorts are current at execution time and independently verified;
- the three hotspot components have clear, tested ownership seams;
- harmonic and buckling studies pass analytical and browser gates;
- shell and beam releases pass patch/closed-form/mesh-convergence gates and disclose their linear-model limits.

