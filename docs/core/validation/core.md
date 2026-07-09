# OpenCAE Core Validation Suite

This document defines the Core validation suite for mesh-native OpenCAE models. The suite is intended to run without UI, Cloud FEA, React, or browser services.

## How To Run

```sh
pnpm --filter @opencae/core test
pnpm --filter @opencae/solver-cpu test
```

For compiler coverage:

```sh
pnpm --filter @opencae/core typecheck
pnpm --filter @opencae/solver-cpu typecheck
pnpm --filter @opencae/core build
pnpm --filter @opencae/solver-cpu build
```

## Supported Model Schema

The validation suite targets `opencae.model` schema `0.2.0`, while preserving compatibility with normalized `0.1.0` static Tet4 models.

Supported mesh-native primitives:

- Tet4 volume elements for CPU solving.
- Tet10 as schema-valid mesh data, currently rejected by the CPU solver with `unsupported-element-type`.
- Surface facets and surface sets for load application and result surface extraction.
- Node sets, element sets, fixed and prescribed-displacement boundary conditions.
- Nodal force, surface force, pressure, and body gravity loads.
- Static linear and dynamic linear steps.
- Material density and yield strength metadata.
- Solver coordinate metadata using `m-N-s-Pa` or `mm-N-s-MPa`.

## Solver Assumptions

The CPU reference solver assumes small-strain, linear isotropic elasticity on Tet4 meshes. The sparse static path assembles a CSR stiffness matrix and solves free DOFs with conjugate gradient. The dynamic MDOF path uses lumped Tet4 mass, optional Rayleigh damping, and Newmark average acceleration.

Constraints must remove rigid-body modes. Missing or insufficient constraints are expected to fail clearly, usually through a singular CG system.

Production APIs do not fall back to local estimates, display-bounds proxy solves, or preview dynamic scaling. A model that identifies its mesh source as a display-bounds proxy is rejected with:

```text
OpenCAE Core requires an actual volume mesh for this solve. No estimate fallback was used.
```

Dynamic solves require density on every solved material. Missing density fails with:

```text
Dynamic solve requires material density.
```

## Static Benchmarks

The static validation suite covers:

- Axial bar tension: stress is checked against `F / A`, displacement against `F L / (A E)`, and reactions against the applied load.
- Cantilever beam: tip displacement and stress are compared to elementary beam theory with coarse Tet4 tolerance.
- Pressure patch: total load is checked as `pressure * selected surface area`.
- Body gravity: total reaction is checked as `density * volume * acceleration`.

The axial and load-balance checks use tight force-balance tolerances. The cantilever benchmark uses a deliberately coarse one-cell Tet4 mesh and only guards order-of-magnitude beam behavior. The documented tolerance is `0.05x` to `25x` of beam-theory displacement and stress, because this fixture is a regression guard for solver wiring, not a mesh-converged beam benchmark.

## Dynamic Benchmarks

The dynamic validation suite covers:

- Zero load remains zero for displacement, velocity, and acceleration.
- Ramp load has frame 0 near zero.
- Step load can produce immediate acceleration and early response.
- Half-sine load starts and ends at near-zero load scale.
- `outputInterval` controls emitted frame count.
- MDOF response changes across frames and is not a repeated static-copy sequence.
- Missing density fails.
- Excessive frame requests fail with a frame-budget diagnostic.

## Mesh Topology Requirements

Core mesh validation covers:

- Connected Tet meshes report one component.
- Disconnected Tet meshes report multiple components.
- Boundary surface facets can be extracted from volume connectivity.
- Surface sets map back to unique sorted node sets.
- Orphan nodes are detected.
- Solver surface meshes are derived from actual boundary facets.

Complex geometry must provide an actual connected volume mesh for Core solving. Display geometry, bounding boxes, or visual-only surface data are not enough.

## Result Surface Fields

Core results include a solver surface mesh derived from the solved volume mesh. `surfaceMesh.nodeMap` is ordered one-to-one with `surfaceMesh.nodes` and maps each surface node back to its volume node id. Any field with `surfaceMeshRef` must be a node field with exactly one value per solver surface node. Displacement vectors and samples, when present, must use the same surface-node order.

Static and dynamic Core results expose surface displacement and recovered nodal von Mises stress fields for visualization. The `displacement-surface` field uses millimeters and includes surface-node-aligned vectors. The `stress-surface` field uses MPa and is tagged with `visualizationSource: "volume_weighted_nodal_recovery"` and `engineeringSource: "raw_element_von_mises"`. It is not used as the engineering max. `summary.maxStress` and safety factor calculations stay tied to raw element von Mises values.

The plot stress field is built by volume-weighted nodal recovery from connected element von Mises stress, then sampled through `surfaceMesh.nodeMap`. The cloud service must not fabricate surface samples from element stress by index. The `stress-visualization` diagnostic records engineering max stress in MPa, plot min/max stress in MPa, `volume_weighted_nodal_recovery`, surface node/triangle counts, stress/displacement field value counts, field alignment status, fixed/load centroids, and effective lever arm in millimeters.

Production rendering has no replacement sampling path. Missing `surfaceMeshRef`, missing `surfaceMesh.nodeMap`, or field lengths that differ from `surfaceMesh.nodes.length` are invalid Core results and must be rejected by solver, cloud, or viewer boundaries.

## Bracket Regression Fixture

The validation suite includes a small bracket-like Tet mesh with:

- A base mount surface.
- An upright load surface.
- A triangular gusset/rib surface.
- A hole-wall style surface selection ID.

The regression requires:

- Volume mesh connected component count is `1`.
- Support and load surfaces are non-empty.
- Static sparse solve completes.
- Dynamic MDOF solve completes.
- Solver surface mesh topology stays connected.

This fixture is intentionally small. It validates topology, load routing, result surface extraction, and solver integration for non-block geometry. It is not a certified engineering benchmark.

## OpenCAE Core Cloud

The `services/opencae-core-cloud` package is the container-oriented Core Cloud runner. It exposes:

- `GET /health`
- `POST /solve`

The health response reports:

- `mesher: "gmsh"`
- `gmshAvailable: true | false`
- `supportsProceduralGeometry: true`
- `supportsUploadedCad: true`
- `supportedAnalysisTypes: ["static_stress", "dynamic_structural"]`
- `supportedSolvers: ["sparse_static", "mdof_dynamic"]`
- `supportsActualVolumeMesh: true`
- `supportsPreview: false`
- `noCalculix: true`
- `noLocalEstimateFallback: true`

`POST /solve` accepts exactly one of an OpenCAE Core model, a Core volume mesh input, or a geometry source. Geometry requests use:

```ts
{
  runId?: string;
  analysisType: "static_stress" | "dynamic_structural";
  study?: unknown;
  displayModel?: unknown;
  solverSettings?: Record<string, unknown>;
  resultSettings?: Record<string, unknown>;
  geometry?: {
    kind: "sample_procedural" | "uploaded_cad" | "uploaded_mesh" | "structured_block";
    sampleId?: "cantilever" | "beam" | "bracket";
    format?: "step" | "stl" | "obj" | "msh" | "json";
    filename?: string;
    contentBase64?: string;
    units?: "mm" | "m";
    geometryDescriptor?: Record<string, unknown>;
  };
}
```

The geometry flow is always geometry source, actual volume mesh, mesh validation, Core model v0.2, Core solve, then `CoreSolveResult`. The cloud service uses Gmsh only to mesh procedural or uploaded CAD geometry. Gmsh output is converted to Core nodes, Tet4/Tet10 element connectivity, boundary surface facets, physical surface sets, and source selection metadata before any solve is attempted.

Procedural Bracket geometry creates a fused base, upright, and gusset/rib solid with cylindrical cutouts. It tags physical surfaces `fixed_support`, `load_surface`, `hole_surfaces`, `base_surfaces`, `upright_surfaces`, and `gusset_surfaces`; `fixed_support` maps to `FS1`/`face-base-left`, and `load_surface` maps to `L1`/`face-load-top`.

If Gmsh is unavailable or meshing fails, `/solve` returns an explicit meshing error. The service does not run a local estimate, display-bounds proxy, or legacy file handoff. After model construction, `static_stress` routes to `solveCoreStatic`, `dynamic_structural` routes to `solveCoreDynamic`, preview requests are rejected, and the returned `CoreSolveResult` keeps `solver: "opencae-core-cloud"`, `meshSource: "actual_volume_mesh"`, and `resultSource: "computed"` provenance.

## Known Limitations

- CPU solving currently supports Tet4 only.
- Tet10 is retained in schema and mesh topology utilities but rejected by the CPU solver.
- The sparse static solver uses CG and expects a symmetric positive-definite constrained system.
- Contact, tie, multi-part interaction, large deformation, plasticity, thermal loading, and nonlinear material behavior are not implemented.
- The preview SDOF dynamic solver remains available only for legacy preview behavior. Complex Core FEA should use the MDOF dynamic solver.
- The validation benchmarks are regression tests for Core behavior. They are not a substitute for mesh convergence, verification against reference solvers, or engineering certification.
