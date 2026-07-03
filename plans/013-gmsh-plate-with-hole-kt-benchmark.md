# Plan 013: First Real-Geometry Benchmark — Gmsh Plate-With-Hole Stress Concentration (+ Pin Gmsh)

Base commits: OpenCAE-Core (sibling) `08ca7a6`; open-cae `d1556f2` for the mirror Dockerfile touch.
Status: TODO
Priority: 3 of the engineering-validity plans. Do AFTER plan 011 (needs CI with gmsh available to pay off) — the gmsh pinning part is independent and can ship immediately.
Category: validation / reproducibility

## Problem

Every quantitative solver gate runs on the procedural **structured block** — the gmsh pipeline (`.geo` script → gmsh → mesh intake → solve), which is exactly what real/uploaded geometry uses and what the product's stated direction (uploaded-CAD cloud solves) depends on, has **zero quantitative accuracy gates**. There is no benchmark containing a stress gradient/concentration of known magnitude, so mesh-quality, intake, and recovery errors on non-trivial geometry are invisible.

Note: `examples/plate-with-hole/` in open-cae is a red herring — its README says it "presents as the Beam Demo"; **no holed-plate geometry exists anywhere yet**.

Additionally, `gmsh` is installed UNPINNED in both container images (open-cae `services/opencae-core-cloud/Dockerfile:29` and sibling `services/opencae-core-cloud/Dockerfile:9`: `apt-get install -y --no-install-recommends gmsh`). Rebuilding the image on a different day can silently change the mesher version and therefore meshes and results — a reproducibility hole in the solver toolchain.

## The Benchmark

Thin rectangular plate, central circular hole, uniaxial tension — the classical stress-concentration case:

- Geometry (mm): width W = 60, length L = 120 (tension along length), thickness t = 6 (thin ⇒ near-plane-stress in 3D), hole diameter d = 15 ⇒ d/W = 0.25.
- Material: mat-steel (E = 200 GPa, ν = 0.29 — read the repo's values and use those).
- Load: uniform tension σ_nom,gross = P/(W·t) applied as a surface force on one end face; other end fixed in the loading direction (support pattern below).
- Oracle: finite-width stress-concentration factor on the NET section, Heywood/Howland fit
  `Kt_net ≈ 2 + (1 − d/W)³` (Peterson's approximation for a plate with a central hole in tension)
  → Kt_net ≈ 2 + 0.75³ = 2.422 at d/W = 0.25, with σ_net = P/((W−d)·t).
  Expected peak stress at the hole edge ≈ Kt_net × σ_net. Use a GENEROUS first gate: peak von Mises within **±15%** of Kt_net·σ_net at the fine preset (3D thin plate vs 2D plane stress, von Mises vs σ_xx at the hole edge, and element-peak sampling all contribute deviations — record the measured ratio in the assertion message so the tolerance can be tightened with evidence). Also gate the reaction: |reaction − P| ≤ 1% of P.
- Boundary conditions matter for the oracle: fix the far end face in x (loading direction) only if the intake supports per-component constraints; if only full fixities exist (`type: "fixed"` clamps x,y,z — check `packages/core/src/loads.ts` / boundary-condition types), clamp the far END face fully but put the hole at plate CENTER (Saint-Venant: clamp-induced stresses decay well before the hole at L/W = 2) and note the residual effect in a comment.

## Implementation Steps (sibling repo unless stated)

1. Read how the bracket sample does it: `services/opencae-core-cloud/src/geometry/bracket.ts` (the `.geo` script builder, mesh-size handling, physical groups / face-id conventions) and `coreModelFromGeometry.ts` (how gmsh output becomes a core model, which face ids exist for constraints/loads). Match those conventions exactly.
2. Add a `plateWithHole` procedural geometry: `.geo` script (box minus cylinder via gmsh boolean, `Physical Surface` groups for the two end faces and hole surface; characteristic mesh size = base size × preset scale like the bracket, PLUS local refinement at the hole — gmsh `Field[1] = Distance`/`Threshold` around the hole edge or a smaller size on the hole surface; without local refinement the coarse presets will badly miss Kt).
3. Register the new sample id through the same routing the bracket uses (`server.ts` geometry-kind dispatch, `types.ts`) so a `CoreCloudSolveRequest` with `geometry.kind: "sample_procedural", sampleId: "plate_with_hole"` meshes and solves. Do NOT wire it into the open-cae web UI in this plan.
4. New test `services/opencae-core-cloud/tests/plate-with-hole-accuracy.test.ts`, harness-style identical to `cantilever-accuracy.test.ts`: build request (tension load on end face, fixed support on the other), solve at medium and fine presets, assert:
   - reaction balance ≤ 1%;
   - peak von Mises within ±15% of Kt_net·σ_net at fine;
   - fine-preset peak ≥ medium-preset peak × 0.95 (refinement must not lose the concentration);
   - mesh contains > some floor of elements near the hole (guards against silent refinement loss — derive the check from mesh statistics available in the intake result).
   Requires the `gmsh` binary; follow whatever skip/require convention `geometry-intake.test.ts` uses when gmsh is absent, but the test must RUN (not skip) in CI from plan 011.
5. Pin gmsh (both repos): change `apt-get install -y --no-install-recommends gmsh` to an exact version (`gmsh=<version>` — use the version currently in the deployed image: run `gmsh --version` in the sibling Dockerfile build or check Debian bookworm's current pin) in sibling `services/opencae-core-cloud/Dockerfile:9` AND open-cae `services/opencae-core-cloud/Dockerfile:29`. Also surface the gmsh version in the runner's diagnostics/provenance if a natural field exists (`healthResponse` already runs `assertGmshAvailable` — check whether the version string is captured; if a one-line addition exposes it in health/diagnostics, do it).
6. Update `BENCHMARKS.md` with the case, oracle formula, and measured ratios.
7. Run `pnpm -C services/opencae-core-cloud test` locally WITH gmsh installed; record the measured Kt ratio per preset in the PR body.

## Verification Gates

```sh
gmsh --version   # present locally
pnpm -C <sibling>/services/opencae-core-cloud test
pnpm -C <sibling> typecheck
```

Expected: new suite green; existing suites untouched and green; both Dockerfiles show a pinned gmsh version.

## Done Criteria

- A holed-plate request solves through the real gmsh path in tests with the Kt and reaction gates above.
- Measured Kt ratios recorded in BENCHMARKS.md and the PR body.
- `grep -n "install .* gmsh" */Dockerfile` in both repos shows pinned versions.

## Out Of Scope

- Web UI exposure of the new sample; uploaded-CAD intake changes; solver code changes; CI wiring (plan 011).

## Maintenance Note

This is the template for future real-geometry gates (fillet, notch, contact-free assemblies). When the gmsh pin is bumped, the Kt test is the tripwire for mesher behavior changes — bump the pin only in a PR where this suite runs.

## Escape Hatches

- Peak stress misses the ±15% gate at fine preset after honest local refinement → STOP and report measured vs oracle per preset with mesh stats; possible causes (element quality at the hole, recovery, intake) are findings for the maintainer, not tolerances to widen silently.
- Gmsh boolean/refinement scripting fights the current `.geo` builder conventions → STOP and propose the minimal geometry-builder extension needed rather than hand-rolling a divergent path.
- If per-component constraints don't exist and the fully-clamped far face measurably pollutes the hole stress (check by comparing hole-edge stress on the loaded vs fixed side), report it and gate on the loaded-side value.
- Debian's gmsh package version cannot be pinned reliably (repo archive rotation) → pin via the official gmsh SDK tarball with a checksum instead, and say so in the PR.
