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
- `results` is optional and stores the active/completed run id, a structural or modal result summary, and result fields for completed local files.

Uploaded STEP, STP, STL, and OBJ source data can be embedded into the project metadata as base64 when the browser has the uploaded model content available. This makes saved local project files self-contained for reopening in the web app.

Runtime artifacts are stored separately under `data/artifacts` during local API use. Those artifacts include uploaded models, display metadata, mesh summaries, solver inputs/logs, result bundles, HTML reports, and PDF reports.

## OpenCAE Core model schema 0.3.0

Core readers accept `0.1.0`, `0.2.0`, and `0.3.0`. Schema `0.3.0` adds a `modal` step with `boundaryConditions` and `modeCount` (1–10). Modal steps use material density and supports but no load references.

Modal result bundles are discriminated by `summary.analysisType: "modal_analysis"`. Each mode records its 1-based index, frequency in Hz, eigenvalue, scaled residual, and field id. Its `mode_shape` field is a node-located 3-vector surface field with `normalized` units; it is never labeled as displacement. Shape vectors are normalized to a maximum nodal vector magnitude of 1 and have deterministic, physically arbitrary sign.

The outer `opencae-local-project` container remains version 2 because the new study and result shapes are backward-readable additions. Legacy structural summary/field bundles continue parsing unchanged.
