# Architecture

OpenCAE Core is a TypeScript FEA core shared by two product tiers:

- **OpenCAE Core Local** — the basic in-browser tier. The OpenCAE web app runs
  `@opencae/solver-cpu` inside a Web Worker against simple block-like geometry
  (Tet4, force loads, capped DOFs). Fast, private, approximate.
- **OpenCAE Core Cloud** — the full tier. The same solver packages run in a
  Node.js container (`services/opencae-core-cloud`) behind a Cloudflare Worker,
  with Gmsh geometry-to-mesh (uploaded CAD, procedural samples), second-order
  Tet10 elements by default, pressure/surface loads, and higher resource limits
  (DOFs, transient frames, end time).

```text
web app (github.com/esaueng/OpenCAE)
  ├── local: solver worker ──────────────┐
  └── cloud: Worker → container (Gmsh)   │
                                          ▼
                              @opencae/core        model schema, validation,
                                                   loads, topology, results
                              @opencae/solver-cpu  Tet4 + Tet10 stiffness,
                                                   sparse CG (Jacobi, warm-start),
                                                   Newmark MDOF dynamics with
                                                   frequency-calibrated Rayleigh
                                                   damping
                              @opencae/viewer      browser visualization
```

## Solver capabilities (solver-cpu)

- Static linear elasticity (`solveCoreStatic`): dense LU for tiny systems,
  CSR conjugate gradient with Jacobi preconditioning otherwise.
- Transient dynamics (`solveCoreDynamic`): implicit Newmark (β=0.25, γ=0.5),
  lumped mass (HRZ lumping for Tet10), Rayleigh damping calibrated from an
  inverse-power-iteration estimate of the fundamental frequency, effective
  matrix reused across constant-dt steps, CG warm-started from the previous
  displacement.
- Elements: Tet4 (single-point) and Tet10 (4-point Gauss isoparametric).
  `elevateTet4MeshToTet10` in `@opencae/core` upgrades straight-sided meshes.
- Materials: isotropic linear elastic with density and yield strength.

Not implemented: modal/eigen analysis, thermal, contact, plasticity or other
nonlinearity, shells/beams.

## Tier differentiation

The local tier is intentionally the smaller solve: Tet4 preview meshes, force
loads only, browser DOF caps. The cloud tier owns real meshing (Gmsh, order 2
by default — Tet10) and the larger limits; its `/health` endpoint advertises
`supportedElementTypes` and `solverLimits`. The cloud rejects preview/local
estimate provenance instead of silently downgrading.

## Placeholders

`packages/solver-wasm` (WASM port) is a placeholder and `packages/solver-webgpu`
is capability detection only. They mark the intended future for the local tier
(matrix-free WebGPU/WASM solving in the browser) and are not in any execution
path today.
