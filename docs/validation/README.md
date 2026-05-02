# Validation

OpenCAE uses two different result classes:

- Local heuristic results are estimates for interactive setup and workflow feedback.
- Cloud FEA results are trusted only when they are parsed from CalculiX output with explicit `calculix_fea` provenance.

The validation suite exists to prevent unit, provenance, and fallback regressions. In particular, the 100 mm x 30 mm x 10 mm cantilever with a 1 N load must stay near the hand estimate and SimScale comparison range, not a fallback-scale value such as 28.7 MPa.

Run the normal TypeScript suite with:

```sh
pnpm test
```

Run the Cloud FEA container validation suite without Cloudflare with:

```sh
python3 services/opencae-fea-container/tests/run_validation.py
```

or:

```sh
pnpm test:fea-container
```

The container validation command always runs analytical, mesh, deck, load-sum, parser, and provenance checks. CalculiX integration checks are skipped when `ccx` is not installed.

## Benchmark Matrix

| Case | Model | Material | Load and support | Expected equations | OpenCAE tolerance | External comparison |
| --- | --- | --- | --- | --- | --- | --- |
| Cantilever bending block | `L=100 mm`, `W=30 mm`, `H=10 mm` | Aluminum 6061, `E=68900 MPa`, `yield=276 MPa` | Fixed `x=0`; total `1 N` in `-Z` on free end face | `I = W H^3 / 12`; `sigma = F L (H/2) / I`; `delta = F L^3 / (3 E I)` | Stress initially `[0.10, 0.30] MPa`; displacement `[0.0005, 0.004] mm`; reaction `1 N +/- 0.03`; stress must be `< 1 MPa`; safety factor must be `>= 500` | SimScale screenshot/reference is around `0.13-0.20 MPa`; hand estimate is `0.20 MPa`, `0.00194 mm` |
| Axial tension block | `L=100 mm`, `W=30 mm`, `H=10 mm` | Aluminum 6061 | Fixed `x=0`; total `1 N` in `+X` on free end face | `A = W H`; `sigma = F/A`; `delta = F L/(E A)` | Stress initially `[0.002, 0.01] MPa`; reaction near `1 N`; total CLOAD vector must sum to `1 N` | Analytical `F/A = 0.00333 MPa` |
| Material swap | Same cantilever block | Aluminum 6061 vs PETG, `E=2100 MPa`, `yield=50 MPa` | Same 1 N bending load/support | Force-controlled linear static stress should be mostly independent of `E`; displacement scales approximately as `1/E` | PETG/aluminum displacement ratio must be broadly near `68900/2100 = 32.8`, accepted `[20, 45]` for parsed solver checks and `[25, 40]` for analytical checks | Analytical displacement ratio `32.8x` |
| Load scaling | Same cantilever block | Aluminum 6061 | Same support; compare 1 N vs 2 N | Linear static response: `sigma` and `delta` scale with load; safety factor scales as `1/load` | 2 N / 1 N stress and displacement ratios accepted `[1.7, 2.3]`; safety-factor ratio accepted `[0.43, 0.58]` | Analytical ratio exactly `2x`, safety factor `0.5x` |
| Mesh convergence | Same cantilever block | Aluminum 6061 | Same 1 N bending load/support | Structured mesh densities: standard `20x6x4`, detailed `40x10x6`, ultra `80x16x10` | Node and element counts must increase by fidelity; parsed displacement should not vary by more than `2.5x`; stress must remain `< 1 MPa`; safety factor must remain `>= 500` | Initial tolerance is broad until more benchmark data is collected |

## Hard Failure Rules

Validation fails if any of these conditions are found:

- A Cloud FEA result contains generated, fallback, placeholder, heuristic, or local-estimate provenance.
- A result sample source contains `generated-cantilever-fallback`.
- The 1 N aluminum cantilever reports stress greater than `1 MPa`.
- The 1 N aluminum cantilever reports safety factor below `500`.
- The solver publishes fields without parsed CalculiX provenance (`parsed_dat` or `parsed_frd_dat`).

## Notes

The current trusted Cloud FEA path is the structured hexahedral block path in the CalculiX container. Arbitrary STEP/Gmsh meshing is intentionally outside this validation scope until a separate meshing benchmark set is available.
