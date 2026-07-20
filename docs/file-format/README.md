# File Format

OpenCAE local project files use JSON and are saved with `.opencae.json` by default.

```json
{
  "format": "opencae-local-project",
  "version": 2,
  "savedAt": "2026-05-02T00:00:00.000Z",
  "project": {},
  "displayModel": {},
  "results": {}
}
```

- `project` contains schema-versioned project metadata, geometry file records, studies, loads, supports, mesh settings, and run references.
- `displayModel` contains the browser display representation, face references, optional visual mesh data, and optional native CAD metadata.
- `results` is optional and stores the active/completed run id, a structural, modal, or steady-state thermal result summary and result fields for completed local files.

Static and dynamic structural studies may contain `loadCases` and `loadCombinations`. Each load id appears in exactly one case. Cases do not contain their own supports, material, geometry, mesh, or solver settings. Combination factors are finite signed numbers that reference static case ids directly; nested combinations are not valid. Readers synthesize one enabled `Default` case containing every load when those arrays are absent in an older project.

Structural `results` may include `variants`, lightweight `variantRefs`, and `activeVariantId`. Variant kinds are `case`, `combination`, and `envelope`; dynamic case refs can be marked `persistedSeparately` because their full transient fields live in per-case IndexedDB records. An envelope may store compact `governingVariantIndices` with one shared variant-id table plus integer stress and displacement arrays. Older single-summary/field structural bundles reopen as one Default case variant. Modal bundles remain modal and are not rewritten as load cases.

Uploaded STEP, STP, STL, and OBJ source data can be embedded into the project metadata as base64 when the browser has the uploaded model content available. This makes saved local project files self-contained for reopening in the web app.

`project.customMaterials` is optional. Each entry uses a UUID id, name, category, Young's modulus and yield strength in Pa, density in kg/m³, Poisson ratio, optional thermal conductivity in `W/(m·K)`, optional copied additive `printProfile`, and `verification: "user_supplied_unverified"`. These definitions are project-scoped; there is no global browser material library. Because this is an optional backward-readable field, the outer container remains version 2.

`project.convergenceRecords` is also optional. Each static-case record stores its study/case ids, probe point and source, completion timestamps, classification, last-step percentage changes, and exactly three `coarse`, `medium`, and `fine` rung summaries. Rungs contain actual mesh/DOF counts and size when available, raw element peak von Mises stress, probe displacement magnitude, status, and an optional skip/failure reason. Solver meshes, surface fields, and result bundles are deliberately excluded. These compact records persist through workspace autosave and the same version-2 portable container.

The open-section clipping plane is not part of this file format. Its enabled state, X/Y/Z axis, normalized offset, and flip direction are browser workspace UI preferences only.

Runtime artifacts are stored separately under `data/artifacts` during local API use. Those artifacts include uploaded models, display metadata, mesh summaries, solver inputs/logs, result bundles, HTML reports, and PDF reports.

## OpenCAE Core model schema 0.4.0

Core readers accept `0.1.0`, `0.2.0`, `0.3.0`, and `0.4.0`. Schema `0.3.0` adds a `modal` step with `boundaryConditions` and `modeCount` (1–10). Modal steps use material density and supports but no load references.

Schema `0.3.0` also adds four mesh-native load records. Values are always stored in the model coordinate system's canonical force units:

- `surfaceTraction` references a `surfaceSet` and stores a three-component `traction` force-density vector in Pa (`N/m^2`) for `m-N-s-Pa` models or MPa (`N/mm^2`) for `mm-N-s-MPa` models.
- `bodyForceDensity` references an explicit `elementSet` and stores a three-component `forceDensity` vector in `N/m^3` or `N/mm^3`.
- `remoteForce` references a `surfaceSet` and stores `totalForce` plus explicit `remotePoint` coordinates. It represents an equivalent distributed force and moment, not a rigid multipoint coupling.
- `equivalentBoltPreload` references two surface sets and stores a unitless direction vector `axis` plus positive `preloadForce`. It is static-only and represents equal/opposite bonded-linear tractions without contact, slip, or fastener stiffness.

The project-level load discriminators are `surface_traction`, `volume_force`, `remote_force`, and `bolt_preload`. Remote points and bolt secondary-selection references live in each load's optional parameter metadata. These optional records do not change the outer project-container version.

Modal result bundles are discriminated by `summary.analysisType: "modal_analysis"`. Each mode records its 1-based index, frequency in Hz, eigenvalue, scaled residual, and field id. Its `mode_shape` field is a node-located 3-vector surface field with `normalized` units; it is never labeled as displacement. Shape vectors are normalized to a maximum nodal vector magnitude of 1 and have deterministic, physically arbitrary sign.

Schema `0.4.0` adds steady-state conduction and solved assembly connections:

- `isotropicLinearElastic` materials may carry `thermalConductivity`. It is `W/(m·K)` in `m-N-s-Pa` models and `W/(mm·K)` in `mm-N-s-MPa` models; adapters convert catalog values explicitly.
- `prescribedTemperature` fixes a node or surface set in degrees Celsius. `surfaceHeatFlux` is positive heat entering a surface in `W/m²` or `W/mm²`. `volumetricHeatGeneration` is positive internally generated heat in `W/m³` or `W/mm³`.
- `steadyStateThermal` references the temperature boundary conditions and heat loads. Thermal results report Celsius temperatures, heat-flux vectors, and relative energy-balance error.
- `meshConnections` records `fuse`, `tie`, or `contact`. Tie and contact reference source/target surface sets and may provide positive search tolerance and penalty scale. Contact is `frictionless` and `small_sliding`.

The schema 0.4 contact implementation is a linearized initially closed normal penalty. It does not encode separation/re-closure, friction, or large-sliding state history.

The outer `opencae-local-project` container remains version 2 because the new study and result shapes are backward-readable additions. Legacy structural summary/field bundles continue parsing as one Default run variant.

## Self-contained result viewer

The `.html` result export is a separate, standalone artifact rather than a project container. It embeds one `opencae-result-viewer` version-1 payload containing the display metadata, solved surface mesh, summary, fields, and provenance. The file uses inline CSS/JavaScript and makes no server or network requests.

## Selected-state raw result exports

CSV and VTK XML UnstructuredGrid (`.vtu`) exports use `opencae_export_schema_version` 1.0.0. Both formats contain one active result variant and one selected static state, dynamic frame, modal mode, or harmonic frequency. They preserve canonical field values and explicitly record the right-handed Z-up coordinate system, length units, per-field units/components/locations, variant identity, and state identity.

CSV is a mixed node/element table with stable one-based source identifiers and canonical connectivity. Field column headers encode field id, type, location, component, and units. VTU stores Tet4/Tet10 volume cells using VTK cell types 10/24. Its `OpenCAE.Metadata.UTF8` `UInt8` FieldData array is UTF-8 JSON containing the export metadata and field catalog. Solver-surface nodal fields are mapped through the retained volume-node map; volume-interior tuples are `NaN`, never extrapolated. Export is chunked and has a 128 MB estimated browser-memory ceiling.
