# Third-Party Notices

This file summarizes third-party license notices for OpenCAE runtime tools,
CAD import components, and generated or transitive dependency notices. It does
not change the license of OpenCAE source code.

## OpenCAE

- OpenCAE source code: Apache License 2.0
- Copyright 2026 Esau Engineering

## Runtime Solver and Meshing Tools

### CalculiX CrunchiX (`ccx`)

- Purpose: Used by the Cloud FEA container/adapter as a separately invoked executable for finite-element solves.
- License: GPL-2.0-or-later
- Notes:
  - OpenCAE generates solver input files and invokes `ccx` as an external executable.
  - CalculiX is not relicensed under Apache-2.0.
  - If a container image or binary distribution includes CalculiX, the distributor must comply with the CalculiX/GPL license obligations, including license notices and source availability requirements.

### Gmsh

- Purpose: Used by the Cloud FEA container/adapter as a separately invoked meshing/staging tool when uploaded geometry needs generated mesh data.
- License: GPL-2.0-or-later WITH Gmsh-exception
- Notes:
  - OpenCAE invokes Gmsh as an external executable for meshing/staging work.
  - Gmsh is not relicensed under Apache-2.0.
  - If a container image or binary distribution includes Gmsh, the distributor must comply with the Gmsh/GPL license obligations and the Gmsh exception terms.

## CAD Import Libraries

### occt-import-js / Open CASCADE Technology

- Purpose: Browser or Node CAD import support for BREP/STEP/IGES workflows, if present in this repository's dependency files.
- License: `occt-import-js` is LGPL-2.1; Open CASCADE Technology 6.7.0 and later is LGPL-2.1 with the OCCT exception.
- Notes:
  - These components are not relicensed under Apache-2.0.
  - Preserve copyright and license notices.
  - Ensure users can receive, inspect, and replace or modify LGPL-covered components as required by the applicable LGPL terms.

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

## Container Image Distributions

Container images may include third-party binaries installed from Debian or
another package source. Any published OpenCAE container image that includes
CalculiX, Gmsh, OCCT-derived components, or other third-party binaries should
include:

- applicable GPL/LGPL license texts,
- package copyright files where available,
- source-code availability information for exact packaged versions,
- a copy of this third-party notice file.

The current Cloud FEA container build context is `services/opencae-fea-container`.
Because that context cannot directly copy root-level repository files, the
container Dockerfile copies Debian package license and copyright files into the
image on a best-effort basis. Distributors should also include this root
`THIRD_PARTY_NOTICES.md` file with any published container image or release
artifact.
