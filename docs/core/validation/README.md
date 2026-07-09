# OpenCAE Core Validation

See [core.md](./core.md) for the runnable Core validation suite, solver benchmark tolerances, mesh-quality requirements, and current solver limitations.

OpenCAE Core solves the volume mesh supplied in the model JSON. Complex geometry must provide an actual Tet4 volume mesh with surface facets and surface sets. Core must not create or solve a rectangular display-bounds proxy for brackets, holes, ribs, gussets, uploaded CAD, or other non-block shapes.

If a complex display model has no actual volume mesh, preflight should fail with:

```text
OpenCAE Core requires an actual volume mesh for complex geometry. Use Cloud FEA or generate a Core mesh.
```

## Model Schema

Schema `0.2.0` adds Tet4/Tet10 element blocks, surface facets, surface sets, surface force and pressure loads, dynamic linear steps, coordinate metadata, mesh provenance, and optional mesh connection metadata. Legacy `0.1.0` Tet4/static/nodal-force models still validate and normalize internally to `0.2.0`.

Tet10 is currently schema-valid only. `@opencae/solver-cpu` returns `unsupported-element-type` for Tet10 instead of downgrading it to Tet4.

## Mesh Preflight

Validation rejects invalid node indices, invalid connectivity, empty node or surface sets, orphan surface facets, missing load/BC/step references, non-positive Tet4 volume, unsupported element types, and disconnected bodies without `meshConnections`.

For a fused single-solid fixture, `connectedComponents(mesh).componentCount` must be `1`. If a mesh has multiple disconnected bodies, callers must provide explicit tie/contact/fuse metadata or route the job to a solver that supports the intended contact model.

## Loads And Results

Surface force loads are distributed over selected facets by area, then to each facet node. Pressure loads use `pressure * facet area` along an explicit direction or the facet normal. The assembled nodal forces must balance reactions within solver tolerance.

Accurate result visualization should use the solver surface mesh returned by Core metadata. `surfaceMesh.nodeMap` maps each surface node back to the volume mesh node id. Surface visualization fields use `surfaceMeshRef` and must contain one value per surface node, so downstream viewers can render and deform the solved topology instead of projecting values onto unrelated display primitives.

Engineering values remain separate from visualization values. `summary.maxStress` is based on raw element von Mises stress, while the `stress-surface` field is a recovered nodal MPa field marked with `visualizationSource: "volume_weighted_nodal_recovery"` and `engineeringSource: "raw_element_von_mises"`.

Core emits a `stress-visualization` diagnostic with the engineering max in MPa, plot min/max in MPa, recovery method, surface mesh counts, stress/displacement field counts, alignment status, fixed/load centroids, and effective lever arm. This diagnostic is for renderer/debug visibility; safety factor and engineering max still use raw element stress.

## Downstream Adapter Contract

The consuming app adapter should use these paths:

- Use `actualCoreMesh` directly when present.
- Convert Cloud FEA/Gmsh, uploaded mesh, procedural fixture, or future browser mesher output with `volumeMeshToModelJson`.
- Use structured block meshes only for simple one-body rectangular cantilever/block/beam display models.
- Reject complex geometry without actual mesh and route to Cloud FEA or mesh generation.

OpenCAE Core Cloud can now accept a geometry source and produce the actual volume mesh inside the container. A complex cloud request should include `study`, `displayModel`, solver/result settings, and one geometry source:

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

`geometry.kind` may be `sample_procedural`, `uploaded_cad`, `uploaded_mesh`, or `structured_block`. Bracket sample geometry maps `FS1` to `fixed_support` and `L1` to `load_surface`. If a complex request reaches Core Cloud without a procedural or uploaded geometry source, preflight returns:

```text
Complex geometry requires procedural or uploaded geometry for Core Cloud meshing.
```

Gmsh is used only as a cloud mesher. The solve still runs through OpenCAE Core sparse static or MDOF dynamic APIs. If Gmsh is missing or meshing fails, the service returns an explicit meshing error and does not use a local estimate or display-bounds proxy.

For production result rendering, downstream viewers must render `result.surfaceMesh.nodes` and `result.surfaceMesh.triangles` directly when a field such as `stress-surface` has a matching `surfaceMeshRef`. Vertex colors come directly from `stress-surface.values` in the same surface-node order. Production Core rendering must reject missing solver surface meshes or misaligned field values instead of inventing replacement samples.
