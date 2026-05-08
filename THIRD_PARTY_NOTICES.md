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
