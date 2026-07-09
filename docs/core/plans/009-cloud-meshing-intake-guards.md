# 009 — Cloud meshing: intake guards, mesh-quality signal, reproducibility

- **Status:** TODO
- **Written against source commit:** `292a6eb` (branch `improvement-plans` at `2fec8c0` adds only `plans/`). Re-verify excerpts if source changed; on mismatch STOP and report drift.
- **Category:** engineering-validity (geometry/mesh intake, discretization signal, reproducibility)
- **Effort:** M
- **Risk of change:** medium (one deliberate breaking change to upload requests, flagged below)

## Why this matters

The cloud pipeline (geometry → gmsh → Core model → solve) has solid bones — inverted elements are rejected at intake, all meshes are normalized to `m-N-s-Pa` with explicit mm→m scaling, temp handling is safe. Four gaps remain:

1. **Undeclared upload units default to meters.** `units` is optional on geometry requests; an STL modeled in mm uploaded without it is interpreted as meter-scale — a silent **1000× geometry scale error** (1e9 on volumes/masses). Stiffness, stress, deflection, and frequencies come back plausible-looking and completely wrong.
2. **No element-quality signal.** Mesh quality reporting is min/max tet volume + inverted count only. Sliver tets (bad aspect ratio / tiny dihedral angles) degrade accuracy and CG conditioning with zero indication to the user.
3. **Reproducibility is unpinned.** gmsh comes from unversioned `apt-get install gmsh`; the same upload can mesh differently across container rebuilds. The generated geo script / msh file are deleted after parsing, so a result's mesh can never be re-derived or audited.
4. **Late/cryptic failures.** A `.msh` upload containing Tet10 sails through intake and dies at the solver ("unsupported-element-type"); a non-watertight STL dies inside gmsh with a cryptic shell error; an over-fine mesh is fully built and validated before the solver's `max-dofs-exceeded` stops it.

Correction recorded during audit: gmsh's default element order is **1**, so uploaded CAD produces Tet4 by default — the Tet10 exposure is specifically user-supplied `.msh` files (and any future flag changes), not CAD meshing. Step 4 hardens both cheaply.

## Current state (verified excerpts)

Units default — `services/opencae-core-cloud/src/mesh/generateCoreVolumeMesh.ts:22-23`:

```ts
if (geometry.kind === "uploaded_cad") return generateGmshVolumeMeshFromUpload(geometry, { units: geometry.units ?? "m", ...options });
if (geometry.kind === "uploaded_mesh") return parseUploadedMeshGeometry(geometry, { units: geometry.units ?? "m", ...options });
```

Quality summary is volumes-only — `services/opencae-core-cloud/src/mesh/gmsh.ts:481-490`:

```ts
return {
  minTetVolume: volumes.length ? Math.min(...volumes) : 0,
  maxTetVolume: volumes.length ? Math.max(...volumes) : 0,
  invertedElementCount: volumes.filter((volume) => !Number.isFinite(volume) || volume <= 0).length
};
```

Default gmsh args have no element-order flag — `gmsh.ts:524-531` (`[input, "-3", "-format", "msh2", "-o", output]`). Parser retains Tet10 (typeCode 11). Solver rejects Tet4-less blocks late (`packages/solver-cpu/src/solver.ts:428`).

Unpinned mesher — `services/opencae-core-cloud/Dockerfile:8-9`: `apt-get install -y --no-install-recommends gmsh ca-certificates`.

Artifacts deleted after parse — `gmsh.ts:120-122` (`finally { await rm(workdir, …) }`); only the parsed mesh survives.

DOF limit enforced post-mesh, pre-assembly — `packages/solver-cpu/src/solver.ts:53-55` (clean `max-dofs-exceeded` error), after gmsh + model build + validation have already run.

Verified-good behavior to preserve: inverted-element rejection at intake (`coreModelFromMesh.ts` throws when `invertedElementCount > 0`); mm→m scaling and `m-N-s-Pa` stamping (`gmsh.ts:188, 269, 286`); bracket geo script pins `Mesh.ElementOrder = 1` (`geometry/bracket.ts:83`).

## Conventions to match

- Errors: `CoreCloudMeshingError(code, message, { status?, diagnostics? })` (`gmsh.ts`); kebab-case codes; server maps them in `solvePreparationErrorResponse` (`server.ts:333-347`).
- Diagnostics: plain objects via `cloudMeshDiagnostics.ts` — extend, don't restructure.
- Tests: `services/opencae-core-cloud/tests/{mesh.test.ts,geometry-intake.test.ts}` — match style; gmsh may be unavailable on dev machines, so tests must skip or mock where the suite already does (read how existing meshing tests handle gmsh absence first).
- Plan 002 also edits `gmsh.ts` (availability caching, top of file); this plan's edits are in parsing/args/quality regions — coordinate if both in flight.

## Steps

### Step 1 — Require explicit units on uploads (BREAKING, deliberate)

In `generateCoreVolumeMesh.ts`, for `uploaded_cad` and `uploaded_mesh`: when `geometry.units` is absent, throw `CoreCloudMeshingError("units-required", "Uploaded geometry requires an explicit units field (\"mm\" or \"m\"). No default is applied.", { status: 400 })`. Procedural/structured sources keep their own explicit unit handling (bracket declares mm; structured block resolves its own scale — leave both alone).

This changes behavior for any client relying on the meter default. Search this repo's tests for uploads without units and update them to declare units; flag in your report that **external clients must be notified** (the OpenCAE app proxy repo is external — out of reach from here).

Additionally: after parsing, include the mesh bounding-box extents (in meters) in the mesh diagnostics so scale errors are visible at a glance (e.g. `boundingBoxMeters: [dx, dy, dz]`).

### Step 2 — Pin gmsh in the Docker image

In `services/opencae-core-cloud/Dockerfile`, pin the gmsh package version: determine the version available in the base image's Debian release (`docker run --rm node:22-slim bash -lc "apt-get update >/dev/null && apt-cache madison gmsh"`) and pin it (`gmsh=<version>`). Add a comment with the pinned upstream gmsh version string. If the repo offers exactly one version and it can drift only with the Debian snapshot, pin the **base image by digest** instead and document that the digest pins gmsh transitively. Health already reports `gmshVersion` at runtime — no code change needed.

### Step 3 — Element-quality metrics in the mesh summary

Extend `summarizeMeshQuality` (`gmsh.ts:481-490`) — same single pass over Tet4 elements, using coordinates already in hand:

- per-element **aspect ratio** (use a standard cheap metric: longest edge ÷ (6·V / longest-face-area) or circumradius/inradius if you prefer — name the metric in the field, e.g. `maxEdgeToHeightRatio`),
- **min dihedral angle** in degrees,
- report `worstAspectRatio`, `minDihedralAngleDeg`, and `poorQualityElementCount` (aspect > 20 or dihedral < 5° — named constants).

Surface these through `cloudMeshDiagnostics.ts` into solve diagnostics. **Warn only — never reject** on quality (rejection thresholds are an owner decision; inverted elements remain the only hard rejection).

### Step 4 — Early, clear element-order handling

- Add `"-order", "1"` to the default gmsh args (`gmsh.ts:524-531`) — makes today's implicit default explicit and immune to gmsh config drift. The bracket geo script's `Mesh.ElementOrder = 1` stays (harmless duplication of intent).
- In the upload intake path (`parseUploadedMeshGeometry` / model build in `coreModelFromMesh.ts`): when parsed elements include Tet10 (and the solve will therefore fail), throw `CoreCloudMeshingError("tet10-not-solvable", "Uploaded mesh contains Tet10 elements; the CPU solver currently solves Tet4 only. Re-export as first-order tetrahedra.", { status: 422 })` **before** model validation/solve. Keep Tet10 schema-validity in `@opencae/core` untouched (documented design) — this guard is cloud-intake-only.

### Step 5 — Clear non-watertight STL errors

In the gmsh failure path (`gmsh.ts` around the `gmsh-meshing-failed` throws at :100-103, :117-119): scan gmsh stdout/stderr for the known signatures of open-shell failures (inspect real gmsh output messages — e.g. strings mentioning "closed", "shell", "self-intersect", or zero 3D elements produced) and, when matched, use code `surface-not-closed` with message "Uploaded surface mesh does not enclose a volume (not watertight); repair the surface and re-upload." Fall through to the existing generic error otherwise. No new dependencies; no watertightness pre-check (that would need a geometry library — recorded as rejected).

### Step 6 — Post-mesh DOF fast-fail

After parsing the mesh (before Core model build/validation): if `nodeCount * 3` exceeds the request's effective `maxDofs` (mirror the clamp in `server.ts:588` — the solver limit is 30000), throw `CoreCloudMeshingError("mesh-exceeds-dof-limit", "Meshed geometry has <N> nodes (<3N> DOFs), exceeding the solve limit <maxDofs>. Increase element size or reduce geometry detail.", { status: 422 })`. This does not save the gmsh run (unavoidable without speculative pre-mesh estimation — rejected as unreliable) but skips model build + validation and gives an actionable message with the numbers in it.

### Step 7 — Optional mesh artifact retention

Support `solverSettings.keepMeshArtifacts: true`: when set, attach the generated geo script and the raw `.msh` content (base64, each capped at 2 MiB — truncate with a note beyond that) to the response `artifacts`. Default remains off (payload size). Read the msh content before the `finally` cleanup — the temp dir still gets removed.

## Hard boundaries

- **In scope:** `services/opencae-core-cloud/src/mesh/{generateCoreVolumeMesh.ts,gmsh.ts}`, `coreModelFromMesh.ts` (Tet10 guard + DOF fast-fail only), `cloudMeshDiagnostics.ts`, `Dockerfile`, service tests, `docs/validation/core.md` (geometry request `units` now required for uploads — update the schema snippet).
- **Out of scope:** solver packages (`packages/*`); auth/handler layer (plan 002 owns it); procedural geometry dimensions; mesh optimization flags (`-optimize` — rejected as speculative, see index); watertightness pre-checking libraries; changing the 30000 DOF limit.

## Done criteria (machine-checkable)

1. `grep -n '"units-required"\|"tet10-not-solvable"\|"mesh-exceeds-dof-limit"\|"surface-not-closed"' services/opencae-core-cloud/src -r` → all four codes present.
2. `grep -n '"-order"' services/opencae-core-cloud/src/mesh/gmsh.ts` → present in default args.
3. `grep -n "gmsh=" services/opencae-core-cloud/Dockerfile` → version-pinned (or base image digest-pinned with a comment naming the gmsh version).
4. `grep -n "worstAspectRatio\|minDihedralAngleDeg" services/opencae-core-cloud/src` → quality metrics wired through to diagnostics.
5. From `services/opencae-core-cloud`: `vitest run` green; new tests cover: units-required rejection, Tet10 intake rejection, DOF fast-fail, quality metrics on a known small mesh (hand-computable aspect/dihedral for a unit tet — compute expected values in the test comment).
6. From root: `pnpm build && pnpm test:only` green.
7. `docs/validation/core.md` geometry schema snippet shows `units` as required for uploads.

## Test plan

Inline in done criteria. For the quality-metric test use a regular tetrahedron (all dihedral angles ≈ 70.53°) and a deliberately flattened one — assert ranges, not exact floats.

## Maintenance notes

- When Tet10 solving lands (roadmap direction item), remove the Step 4 intake guard in the same PR.
- The `boundingBoxMeters` diagnostic pairs with a future client-side "does this size look right?" confirmation — that UX belongs to the app, not this service.
- Bumping the pinned gmsh version is a deliberate act: re-run the service test suite and the bracket regression, and note mesh-count changes in the commit message.

## Escape hatches

- If existing repo tests or fixtures upload geometry **without** units in ways that look like a deliberate public contract (not just test convenience), STOP on Step 1 and downgrade to: warn + `boundingBoxMeters` diagnostic only; report the conflict for the owner to decide.
- If the Debian repo for the base image cannot pin gmsh at all and digest-pinning the base is refused by CI constraints you discover, report what you found; do not leave the Dockerfile half-pinned.
- If gmsh's open-shell error text can't be reliably identified from a real gmsh run in your environment (gmsh unavailable), implement Step 5 behind the generic error with a TODO diagnostic field and say so — do not guess signatures you never observed.
