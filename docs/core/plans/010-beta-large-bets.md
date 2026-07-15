# Plan 010 — Beta large bets

Status: **implemented on `beta` with the limitations below**

This plan lands the five multi-week product bets as one staged beta while preserving the local, no-server architecture and the existing `m-N-s-Pa` / `mm-N-s-MPa` unit contracts.

## 1. CPU capacity and profiling

- Use typed-array CSR for production static solves and select SSOR automatically for large systems.
- Emit matrix memory, preconditioner, iteration, residual, and timing diagnostics.
- Raise the guarded CPU route to 150,000 DOF.
- Keep dense assembly only for small reference cases.

Acceptance: sparse regression tests converge with Jacobi and SSOR; the validation gallery can run the 100k-class scale case and show measured time and residual.

## 2. Steady-state thermal

- Add schema 0.4 thermal conductivity, prescribed temperature, surface heat flux, volumetric heat generation, and `steadyStateThermal` steps.
- Assemble Tet4/Tet10 conduction matrices and consistent surface/volume heat loads.
- Recover nodal temperature, element heat-flux vectors, and energy-balance diagnostics.
- Expose study creation, setup, solve, result fields, and report/export paths in the web app.

Acceptance: a linear conduction fixture reproduces the exact temperature gradient and Fourier heat flux within solver tolerance.

## 3. Assembly connections

- Preserve body identity during meshing whenever a study contains tie or contact connections; retain Boolean fuse for `fuse` or connection-free workflows.
- Build spatially indexed node-to-surface projections from named face selections.
- Assemble tie MPC penalties in all three displacement components.
- Assemble frictionless small-sliding contact in the initial interface normal while leaving tangential motion unconstrained.
- Apply connection matrices in static and dynamic structural routes.

Acceptance: disconnected assemblies with valid connections pass preflight; tie transfers load and contact adds normal-only coupling.

Beta limitation: frictionless contact is a linearized, initially closed, bilateral normal penalty. Separation, re-closure, changing normals, friction, and large sliding require a nonlinear active-set/contact iteration and are not represented as full unilateral contact.

## 4. WebGPU matrix-free Tet4

- Build deterministic Tet4 element and node adjacency buffers.
- Run the elasticity operator in WebGPU compute without assembling a global stiffness matrix.
- Route static, zero-prescribed-displacement, connection-free Tet4 studies above the CPU ceiling to WebGPU automatically, up to 500,000 DOF.
- Recover engineering stress and reactions through the shared CPU postprocessor and stamp backend provenance.

Acceptance: the CPU reference operator is symmetric and the automatic route rejects unsupported Tet10, connection, combination, or nonzero-prescribed-displacement cases explicitly.

Beta limitation: CG vector updates remain host-coordinated and each matrix-vector product is read back. A later optimization should keep the full Krylov loop and reductions resident on the GPU.

## 5. Trust and sharing

- Add an in-app validation gallery with checked-in cantilever, plate-with-hole, and scale baselines plus live worker reruns.
- Show theory/reference values, tolerance, measured error, solver diagnostics, and pass/fail state.
- Export a single offline HTML result viewer with the surface mesh, result fields, summary, and provenance embedded as base64; provide field/frame/deformation controls with no server dependency.

Acceptance: exported HTML contains no external network dependency and reopens the embedded payload; gallery live runs execute outside the UI thread.

## Release gates

- Build, typecheck, and lint all changed workspaces.
- Run focused numerical regression tests for sparse solve, thermal conduction, connection assembly, matrix-free routing/operator symmetry, and HTML payload export.
- Publish schema/file-format and user-guide changes with explicit units, ceilings, routing rules, and beta limitations.
