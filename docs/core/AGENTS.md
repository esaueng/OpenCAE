# AGENTS.md

## Project
This repository is `opencae-core`.
The primary project name is **OpenCAE Core**.
OpenCAE Core is a browser-local finite element analysis solver core for web applications.
The primary GPU backend is WebGPU.

The MVP target is:
- Tet4
- linear static elasticity
- matrix-free CG
- WebGPU execution
- Wasm/CPU fallback later

## Package Naming
Use the following naming convention:
- repository: `opencae-core`
- root package: `opencae-core`
- core package: `@opencae/core`
- WebGPU solver package: `@opencae/solver-webgpu`
- CPU reference solver package: `@opencae/solver-cpu`
- Wasm solver package: `@opencae/solver-wasm`
- viewer package: `@opencae/viewer`
- examples package: `@opencae/examples`
- web app package: `@opencae/web`

Do not rename the project or introduce competing names.

## Phase 0 Non-Goals
Do not implement Tet4.
Do not implement CG.
Do not implement WebAssembly solving.
Do not implement visualization.
Do not implement CUDA.
Do not implement a server-side solver.
Do not implement CalculiX parsing.

## CPU Solver Scope
The CPU reference solver package is `@opencae/solver-cpu`. It owns dense small-fixture Tet4 static and dynamic structural solve paths. Solver logic must stay out of `@opencae/core`.

## Repository Workflow
Always commit and push changes to the current branch.

After making changes, run:

```sh
git add .
git commit -m "update"
git push
```
