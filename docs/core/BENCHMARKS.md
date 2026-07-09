# Benchmarks

## Accuracy: tip-loaded steel cantilever vs. Timoshenko beam theory

Case: 180 x 24 x 24 mm block, mat-steel (E = 200 GPa, nu = 0.29), 500 N tip load in -Z,
fully clamped at x = 0. Theory: tip deflection 0.1782 mm (Euler-Bernoulli + 6/5 shear
correction), outer-fiber root bending stress 39.06 MPa. Regression-tested in
`services/opencae-core-cloud/tests/cantilever-accuracy.test.ts`.

| Mesh (cloud structured block)             | Tip deflection  | Peak von Mises  | Reaction |
| ----------------------------------------- | --------------- | --------------- | -------- |
| Legacy single cell, 6 Tet4 (pre-0.1.5)    | 0.0040 mm (2%)  | 2.95 MPa (8%)   | 500 N    |
| Single cell elevated Tet10 (0.1.4)        | 0.1295 mm (73%) | 9.37 MPa (24%)  | 500 N    |
| Grid Tet10, coarse preset (360 elems)     | 0.1766 mm (99%) | 43.5 MPa (111%) | 500 N    |
| Grid Tet10, medium preset (1242 elems)    | 0.1771 mm (99%) | 45.2 MPa (116%) | 500 N    |
| Grid Tet10, fine preset (2880 elems)      | 0.1773 mm (100%)| 46.2 MPa (118%) | 500 N    |

Peak von Mises above the beam-theory value is expected: the fully clamped face adds a
real corner stress concentration, and the reported maximum is the unaveraged
element-peak (node-sampled) von Mises. The Tet10 nodal stress recovery
(`recoverElementResults`) samples the linear in-element stress field at the element
nodes; element-centroid maxima systematically clip outer-fiber bending stress.

Dynamic (mdof Newmark, 0.1 s ramp, damping 0.02): end state lands on the static
solution within 0.5% on the medium grid; reaction balances the applied load exactly.

Future benchmark categories:
- model validation cost
- CPU reference solve time
- WebGPU setup time
- matrix-free operator throughput
- CG iteration time
- result post-processing time
- browser memory usage
- end-to-end MVP workflow time
