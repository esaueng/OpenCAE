# Licensing: gmsh-wasm in the OpenCAE web bundle

Decision date: 2026-07-06 (owner decision: stay open source).

## Decision

OpenCAE ships in-browser meshing by default. The mesher is
[`@loumalouomega/gmsh-wasm`](https://github.com/loumalouomega/GMSH-JS), a
WebAssembly build of [Gmsh](https://gmsh.info) (GPL-2.0-or-later) with
[OpenCASCADE Technology](https://dev.opencascade.org) (LGPL-2.1 with
exception) statically linked inside the `.wasm`.

- OpenCAE's own source code remains **Apache-2.0** and public.
- The **combined web-application bundle** — the OpenCAE app as distributed to
  browsers together with gmsh-wasm — is distributed under **GPLv3-compatible
  terms**: Apache-2.0 (our code) is GPLv3-compatible, and Gmsh's
  "GPL-2.0-or-later" grant lets the combination be conveyed under GPLv3.
  Anyone receiving the bundle receives it under terms no more restrictive
  than the GPL requires.
- The root `LICENSE` file (Apache-2.0 for OpenCAE source) is unchanged;
  licensing text there is reviewed by the project owner personally.

## Why browser distribution is different from the old server-side use

Until mid-2026 Gmsh ran only **server-side**, as a separate `gmsh` executable
invoked as a subprocess inside the cloud meshing container. Executing an
unmodified GPL program as a distinct process is *use*, not creation of a
combined/derivative work, and the program was never conveyed to users — so
the GPL's distribution conditions were not triggered for the OpenCAE client
or server code.

Shipping gmsh-wasm to the browser is **distribution**: every page load
conveys the Gmsh + OCCT object code (the `.wasm` asset, served
gzip-precompressed) and the JS glue that links against it to the user's
machine. That triggers the GPL's conditions on the combined work, which is
why the combined bundle is offered under GPLv3-compatible terms rather than
relying on the subprocess-use analysis.

## Source availability

The GPL requires that recipients of the bundle can obtain the corresponding
source:

- OpenCAE application source: this public repository
  (https://github.com/esaueng/open-cae).
- gmsh-wasm source and build scripts (including the pinned Gmsh and OCCT
  sources and the Emscripten build configuration used to produce
  `gmsh-core.wasm`): https://github.com/loumalouomega/GMSH-JS
- Gmsh upstream source: https://gmsh.info / https://gitlab.onelab.info/gmsh/gmsh
- OpenCASCADE Technology upstream source: https://dev.opencascade.org

The exact gmsh-wasm version shipped is pinned in `pnpm-lock.yaml`
(`@loumalouomega/gmsh-wasm`), so the corresponding source for any deployed
bundle is recoverable from the repository history.

## Opt-out build

Deployments that must not carry GPL-licensed code can build with
`VITE_WASM_MESHING=0`. That build path stubs the mesh worker client and the
gmsh-wasm package at bundle time (see `stubMeshWorkerClientWhenDisabled` in
`apps/opencae-web/vite.config.ts`), producing a dist with **zero** gmsh
assets; such builds contain only Apache-2.0/LGPL components and are not
subject to the GPL terms above. In-browser meshing is unavailable in that
configuration and runs that require meshing fail with an actionable error.

## Attribution

Third-party notices for Gmsh, gmsh-wasm, and OpenCASCADE are recorded in
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).
