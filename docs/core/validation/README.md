# OpenCAE Core Validation

See [core.md](./core.md) for the runnable Core validation suite, solver benchmark tolerances, mesh-quality requirements, and current solver limitations.

OpenCAE Core solves the volume mesh supplied in the model JSON. Complex geometry must provide an actual Tet4 or Tet10 volume mesh with surface facets and surface sets. Core must not create or solve a rectangular display-bounds proxy for brackets, holes, ribs, gussets, uploaded CAD, or other non-block shapes.

If a complex display model has no actual volume mesh, preflight should fail with:

```text
OpenCAE Core requires an actual volume mesh for complex geometry. Generate a Core mesh locally in the browser.
```

## Model Schema

Schema `0.2.0` adds Tet4/Tet10 element blocks, surface facets, surface sets, surface force and pressure loads, dynamic linear steps, coordinate metadata, mesh provenance, and optional mesh connection metadata. Schema `0.3.0` adds modal steps, normalized vector mode-shape results, surface traction, body force density, remote force, and equivalent bolt preload. Schema `0.4.0` adds thermal material data, steady conduction boundary conditions/loads/steps, and solved tie/contact metadata. Legacy `0.1.0`, `0.2.0`, and `0.3.0` models remain accepted.

The CPU solver supports Tet4 and Tet10 stiffness, recovery, mass, and load integration. Tet10 inertial and body-force lumping uses positive HRZ weights with exact total-mass/resultant conservation.

## Mesh Preflight

Validation rejects invalid node indices, invalid connectivity, empty node or surface sets, orphan surface facets, missing load/BC/step references, non-positive Tet4 volume, unsupported element types, and disconnected bodies without `meshConnections`.

For a fused single-solid fixture, `connectedComponents(mesh).componentCount` must be `1`. Multiple disconnected bodies must provide explicit tie/contact/fuse metadata. Tie and small-sliding frictionless contact are assembled as spatially projected node-to-surface penalty MPCs; missing or unmappable faces fail before solve.

Steady thermal validation requires positive conductivity for every referenced material, at least one prescribed-temperature node, valid heat-load selections, finite assembled values, CG convergence, and a reported energy-balance residual. Surface and volumetric heat input use consistent facet/element integration for Tet4 and Tet10.

## Loads And Results

Surface force loads are total resultants distributed over selected facets; their visual application point does not affect assembly. Pressure and surface traction integrate force density through the shared Tri3/Tri6-consistent facet path. Body force density integrates over an explicit element set with equal Tet4 or positive HRZ Tet10 weights. Every path reports actual area or volume and must conserve its requested resultant within scale-aware solver tolerance.

Remote force uses an area-weighted minimum-norm distribution with a rank-checked 6x6 constraint solve. Requested and assembled force and remote-point moment must balance; rank-deficient selections fail. Equivalent bolt preload is static-only and applies equal/opposite consistent tractions after checking opposing normals, nonzero areas, separated centroids, axis orientation, connected topology, and net force/moment. It remains explicitly a bonded-linear approximation without contact, slip, or fastener stiffness.

Accurate result visualization should use the solver surface mesh returned by Core metadata. `surfaceMesh.nodeMap` maps each surface node back to the volume mesh node id. Surface visualization fields use `surfaceMeshRef` and must contain one value per surface node, so downstream viewers can render and deform the solved topology instead of projecting values onto unrelated display primitives.

Engineering values remain separate from visualization values. `summary.maxStress` is based on raw element von Mises stress, while the `stress-surface` field is a recovered nodal MPa field marked with `visualizationSource: "volume_weighted_nodal_recovery"` and `engineeringSource: "raw_element_von_mises"`.

Core emits a `stress-visualization` diagnostic with the engineering max in MPa, plot min/max in MPa, recovery method, surface mesh counts, stress/displacement field counts, alignment status, fixed/load centroids, and effective lever arm. This diagnostic is for renderer/debug visibility; safety factor and engineering max still use raw element stress.

## Downstream Adapter Contract

The consuming app adapter should use these paths:

- Use `actualCoreMesh` directly when present.
- Convert browser-Gmsh, uploaded mesh, or procedural fixture output with `volumeMeshToModelJson`.
- Use structured block meshes only for simple one-body rectangular cantilever/block/beam display models.
- Reject complex geometry without an actual mesh and run local mesh generation before solving.

The browser meshing worker accepts `study`, `displayModel`, solver/result settings, and one geometry source:

```json
{
  "geometry": {
    "kind": "sample_procedural",
    "sampleId": "bracket",
    "units": "mm",
    "geometryDescriptor": {
      "baseLength": 120,
      "baseDepth": 34,
      "baseHeight": 10,
      "uprightHeight": 88,
      "uprightWidth": 18,
      "holeDiameters": [12, 12, 10],
      "supportFaceId": "face-base-left",
      "loadFaceId": "face-load-top"
    }
  }
}
```

`geometry.kind` may be `sample_procedural`, `uploaded_cad`, `uploaded_mesh`, or `structured_block`. Bracket sample geometry maps `FS1` to `fixed_support` and `L1` to `load_surface`. If a complex model has neither a saved volume mesh nor a local meshable geometry source, preflight fails before solve.

Gmsh runs through WebAssembly in the browser meshing worker. The resulting Core model is transferred to the dedicated browser solve worker, which routes to sparse static, MDOF dynamic, modal, steady thermal, or the eligible WebGPU static path. If local meshing is unavailable or fails, the run returns an explicit error and does not call a network solver, use a local estimate, or substitute a display-bounds proxy.

For production result rendering, downstream viewers must render `result.surfaceMesh.nodes` and `result.surfaceMesh.triangles` directly when a field such as `stress-surface` has a matching `surfaceMeshRef`. Vertex colors come directly from `stress-surface.values` in the same surface-node order. Production Core rendering must reject missing solver surface meshes or misaligned field values instead of inventing replacement samples.
