# Plan 016: In-Browser WASM Meshing And Offline Asset Caching

Base state: open-cae `main` after plan 015 local-solver parity work begins.
Status: TODO
Priority: local-first migration track, part A/C
Category: architecture / offline capability / licensing

## Problem

The remaining true browser blocker for fully local CAE is volume meshing of complex imported geometry. The current cloud path shells out to native Gmsh in the Core Cloud container. Browser previews already use OCCT WASM for STEP display, but the solve path still needs a local volume mesh, face attribution, quality gates, and cached WASM assets before the product can honestly claim "fully offline."

Important wording: until the service worker exists, the honest claim is "no network needed for mesh/solve once assets are loaded," not full offline availability.

## Desired Behavior

- STEP/imported geometry can be volume-meshed in a dedicated browser worker and produce the same Core model artifact shape the local solver consumes.
- Selections map to real CAD faces, not geometric fallback labels.
- Meshing and solve workers do not run heavy phases concurrently.
- The app shell, OCCT WASM, and mesher WASM are precached so a loaded app can mesh and solve offline.
- Cloud meshing routes are removed only after local meshing reaches the A-M4 gates.

## Mesher Decision Gate

Primary candidate: `@loumalouomega/gmsh-wasm` pinned exactly and vendored.

- Pros: Gmsh/OpenCASCADE in WASM, same mesher family as cloud, native Tet10 support, single-threaded no COOP/COEP requirement, `.d.ts` included.
- Known risk: 3D Delaunay boundary recovery can fail on STEP round trips; retry with `Mesh.Algorithm3D=4` (Frontal).
- Licensing gate: distributing Gmsh WASM is different from server-side `execFile` use. Close this before A-M3 ships.

Fallback: custom Emscripten Netgen build, LGPL-2.1, fed by watertight OCCT tessellation, Tet4 -> `elevateTet4MeshToTet10`.

## Implementation Steps

1. **A-M1: viability spike.**
   - Pin/vendor gmsh-wasm.
   - Add `meshWorker`, protocol, and client using the performance-worker pattern.
   - Extract the pure Gmsh `.msh` parser from the cloud service into a shared package.
   - Mesh a procedural bracket `.geo` locally behind a flag.
   - Day-one STEP smoke: one real STEP file imports via WASM OCC and `generate(3)` produces a valid Tet10 mesh under Vitest. If this fails, stop and re-plan with Netgen.
2. **A-M2: Core model artifacts.**
   - Extract Core model building from mesh artifact into shared code.
   - Wire `generateMesh` in `apps/opencae-web/src/lib/api.ts`.
   - Store the actual Core model artifact under `study.meshSettings.summary.artifacts.actualCoreModel`.
   - Update eligibility so complex geometry plus actual Core volume mesh routes to local solve.
   - Add meshing progress and cancel behavior; hard cancel is `Worker.terminate()` plus respawn.
3. **A-M3: STEP selection and attribution.**
   - Add `stepFaces.ts` face registry from OCCT `brep_faces`.
   - Update `CadViewer.tsx` raycast selection to map triangle index -> face id.
   - Add facet-to-CAD-face attribution by centroid/normal voting against display tessellation.
   - Close the Gmsh licensing path before shipping.
4. **A-M4: quality and retirement gate.**
   - Gate min SICN, inverted elements, connected components, bracket parity, and plate-with-hole Kt.
   - Validate Safari/mobile constraints.
   - Flip default for complex geometry to local.
   - Only then retire cloud meshing routes/container/R2 per plan 015 B4b.
5. **C: offline asset caching.**
   - Add `vite-plugin-pwa`/Workbox precaching for app shell and lazy WASM chunks.
   - Add an "offline ready" signal tied to cache state.
   - Tests/docs must keep the weaker claim until C lands.

## Selection Mapping Requirements

- STEP face ids are stable fingerprints based on quantized area, centroid, and normal.
- `DisplayModel.faces` must represent real STEP faces, replacing uploaded-box fallback faces where possible.
- Acceptance: STEP models resolve via `bySelection`/`byFace`; geometric fallback is not used for normal supported imported geometry.

## Verification Gates

```sh
PATH=/Users/userzero/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH node_modules/.bin/vitest run <new meshing tests>
pnpm typecheck
pnpm test
```

Meshing gates:

- Bracket mesh counts within +/-10% of cloud fixtures; solve KPIs within +/-2%.
- STEP robustness corpus meshes with Delaunay -> Frontal retry matrix.
- Selection mapping asserts non-fallback face ids.
- Quality: min SICN >= 0.05 reject, < 0.2 warn; inverted elements = 0; single connected component.
- Offline manual: load app, go offline in DevTools, mesh and solve bracket/imported sample, assert zero `/api/cloud-core/*` requests.

## Done Criteria

- Complex geometry can mesh and solve locally with real Core volume mesh artifacts.
- Local mesh artifacts are deterministic for fixed mesher version and options.
- Gmsh licensing path is documented and approved, or Netgen fallback replaces it.
- Offline asset cache makes the full claim truthful.
- Cloud meshing infrastructure removal is gated and separately revertible.

## Out Of Scope

- Solver-cpu progress/cancel hooks and result persistence; see plan 015.
- Commercial licensing negotiation itself.
- New public sample gallery or marketing copy.

## Rollback

- Keep cloud meshing available until A-M4 is complete.
- Gate the new mesher behind a feature flag until STEP smoke, robustness, and licensing are settled.
- If gmsh-wasm STEP smoke fails, do not continue building UI on top of it; switch to the Netgen fallback plan.
