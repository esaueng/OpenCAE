# OpenCAE Core

## Mission
OpenCAE Core enables local browser-based finite element analysis using WebGPU.

It is a browser-native, GPU-accelerated FEA core for web applications. WebAssembly may be used later for validation, preprocessing, and CPU fallback/reference solving.

OpenCAE Core is not a port of CalculiX, a CUDA solver, or a server-side solver.

## Repository
Repository/code name:

```text
opencae-core
```

## First Product Target
A user can open a web app, load a simple Tet4 mesh, assign a linear elastic material, apply fixed supports and nodal forces, run a local WebGPU solve, view displacement and von Mises stress, and export result data.

## Phase 0 Scope
Phase 0 establishes repository infrastructure only. It does not implement FEA model types, solver kernels, WebAssembly solving, visualization, mesh loading, or server-side solving.
