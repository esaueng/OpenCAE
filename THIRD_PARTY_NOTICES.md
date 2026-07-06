# Third-Party Notices

This file summarizes third-party license notices for OpenCAE runtime tools,
CAD import components, and generated or transitive dependency notices. It does
not change the license of OpenCAE source code.

## OpenCAE

- OpenCAE source code: Apache License 2.0
- Copyright 2026 Esau Engineering

## CAD Import Libraries

### occt-import-js / Open CASCADE Technology

- Purpose: Browser or Node CAD import support for BREP/STEP/IGES workflows, if present in this repository's dependency files.
- License: `occt-import-js` is LGPL-2.1; Open CASCADE Technology 6.7.0 and later is LGPL-2.1 with the OCCT exception.
- Notes:
  - These components are not relicensed under Apache-2.0.
  - Preserve copyright and license notices.
  - Ensure users can receive, inspect, and replace or modify LGPL-covered components as required by the applicable LGPL terms.

## Meshing Components

### Gmsh

- Purpose: finite-element mesh generation (in-browser via WebAssembly).
- Authors: Christophe Geuzaine and Jean-François Remacle, https://gmsh.info
- License: GPL-2.0-or-later (with a linking exception for Netgen, METIS,
  OpenCASCADE and ParaView). A separate commercial license is available from
  the Gmsh authors.

### @loumalouomega/gmsh-wasm

- Purpose: WebAssembly packaging of the Gmsh C API (geometry + meshing, no
  GUI) used by OpenCAE's in-browser mesh worker.
- Copyright (C) 2026 Vicente Mataix Ferrándiz and gmsh-wasm contributors.
- Source: https://github.com/loumalouomega/GMSH-JS
- License: GPL-2.0-or-later (inherited from Gmsh, which is statically linked
  into the distributed `.wasm`).

### OpenCASCADE Technology (statically linked inside gmsh-wasm)

- Purpose: CAD geometry kernel (`occ`) compiled into `gmsh-core.wasm`.
- Source: https://dev.opencascade.org
- License: LGPL-2.1 with the OCCT exception.

Because the default web build distributes these components to browsers, the
combined OpenCAE web-application bundle is distributed under GPLv3-compatible
terms. OpenCAE's own source code remains Apache-2.0. See
[`docs/licensing-gmsh-wasm.md`](docs/licensing-gmsh-wasm.md) for the full
rationale, the 2026-07-06 stay-open decision, source-availability pointers,
and the GPL-free opt-out build (`VITE_WASM_MESHING=0`).

## JavaScript and TypeScript Dependencies

OpenCAE workspace packages declare their own source code as Apache-2.0, but
package dependencies and transitive dependencies are licensed separately by
their respective authors. Generated dependency notice reports should be
regenerated from the lockfile when dependencies change.

To regenerate a pnpm dependency license report from the current lockfile:

```bash
pnpm install
pnpm licenses list --json > THIRD_PARTY_LICENSES.json
```

If `pnpm licenses list` is unavailable or cannot read the local pnpm store for
this workspace, use a dedicated dependency license scanner in CI and publish or
archive its generated notices alongside release artifacts.
