# Architecture

OpenCAE Core meshes and solves entirely in the browser. The application has no
network solve path and does not fall back to a remote service when local
meshing or solving fails.

```text
geometry / saved project
  |
  +-- WebAssembly Gmsh worker --> Tet4/Tet10 Core volume model
  |                                  |
  +-- existing Core mesh ------------+
                                     v
                              validation + preflight
                                     |
                                     v
                           dedicated browser solve worker
                              |                  |
                              |                  +-- WebGPU matrix-free Tet4 CG
                              +-- CPU Core solvers
                                     |
                                     v
                      local result fields + solver provenance
                                     |
                                     v
                              @opencae/viewer
```

The Cloudflare Worker hosts the static application and may support unrelated
product storage features, but its retired solve routes return HTTP 410. No
geometry, mesh, load, or result is sent to a server for computation.

## Local packages

- `@opencae/core` owns the versioned model schema, topology, validation, load
  definitions, result schemas, and Tet4-to-Tet10 elevation.
- `@opencae/solver-cpu` owns sparse static elasticity, implicit Newmark MDOF
  dynamics, modal analysis, and steady-state conduction. Static and thermal CG
  use automatic SSOR preconditioning.
- `@opencae/solver-webgpu` provides the matrix-free WebGPU Tet4 static route for
  eligible large models.
- `@opencae/mesh-intake` and the browser meshing adapter provide WebAssembly
  Gmsh geometry-to-volume-mesh execution. `@opencae/solver-wasm` remains a
  placeholder and is not a solve route.
- `@opencae/viewer` and the web application render the returned solver surface
  mesh and aligned result fields.

## Solver routing

The solve worker accepts only the normalized `opencae_core_local` backend.
Static CPU results identify `opencae-core-sparse-tet`, dynamic results identify
`opencae-core-mdof-tet`, modal results identify `opencae-core-modal-tet`, and
thermal results identify `opencae-core-steady-thermal`. Eligible large static
Tet4 models may identify `opencae-core-webgpu-matrix-free-tet4`.

Old project files containing `opencae_core_cloud` are accepted only as a
migration alias and are routed locally. Historical cloud results remain
readable with their original provenance; they are never reused as new solve
output. The frozen cloud fixtures are regression data, not a runtime
dependency. See [cloud-retirement.md](../cloud-retirement.md).

## Current capabilities

- Small-strain linear elasticity with Tet4 and Tet10 elements.
- Static, transient dynamic, and modal structural studies.
- Steady-state conduction on the same tetrahedral mesh.
- Surface force, pressure, traction, body-force density, remote force, and
  bonded-linear equivalent bolt preload.
- Tied and initially closed frictionless small-sliding assembly connections
  through node-to-surface penalty MPCs.
- Browser-local WebAssembly meshing for supported CAD, uploaded mesh, and
  procedural geometry inputs.

## Resource boundaries and limitations

The guarded CPU ceiling is 150,000 DOF. The automatic WebGPU route accepts
eligible connection-free static Tet4 models with zero prescribed displacement
from 150,001 through 500,000 DOF. Tet10 and unsupported WebGPU model features
remain on the CPU route and fail preflight when they exceed its limit.

Contact is linearized and bilateral: separation, re-closure, friction, and
changing normals are not implemented. Thermal-stress coupling, convection,
radiation, transient thermal response, large deformation, plasticity, and
nonlinear material behavior are also not implemented. A local meshing or solve
failure is reported directly; it never triggers a remote solve or estimate.
