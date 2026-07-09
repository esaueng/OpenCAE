# Roadmap

## Phase 0 - Repository Foundation
Create the monorepo, documentation, TypeScript configuration, Vite web app, scoped packages, WebGPU capability detection, worker skeleton, fixture placeholder, and tests.

## Phase 1 - Core FEA Model
Define the minimal model structures needed for Tet4 linear static elasticity.

Phase 1 adds solver-neutral OpenCAE native JSON model types, validation, normalization into typed arrays, and fixtures. It does not add solver math or visualization.

## Phase 2 - CPU Reference Tet4 Solver
Build a CPU reference path for validation and baseline correctness.

Phase 2 adds `@opencae/solver-cpu` as a dense direct Tet4 linear static reference solver for small fixtures. It is not the production WebGPU solver.

## Phase 3 - WebGPU Infrastructure
Add WebGPU device setup, buffers, compute pipeline utilities, and diagnostics.

## Phase 4 - Matrix-Free Tet4 WebGPU Operator
Implement the Tet4 matrix-free operator for small-strain linear elasticity.

## Phase 5 - WebGPU CG Solver
Implement the conjugate gradient solve path on WebGPU.

## Phase 6 - Post-Processing and Visualization
Compute result fields and add browser visualization for displacement and von Mises stress.

## Phase 7 - Product MVP Workflow
Connect loading, setup, solve, viewing, and export into a usable browser workflow.

## Phase 8 - Performance Pass
Benchmark, profile, and optimize the MVP workflow.
