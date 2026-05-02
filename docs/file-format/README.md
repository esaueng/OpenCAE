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
- `results` is optional and stores the active/completed run id, result summary, and result fields for completed local files.

Uploaded STEP, STP, STL, and OBJ source data can be embedded into the project metadata as base64 when the browser has the uploaded model content available. This makes saved local project files self-contained for reopening in the web app.

Runtime artifacts are stored separately under `data/artifacts` during local API use. Those artifacts include uploaded models, display metadata, mesh summaries, solver inputs/logs, result bundles, HTML reports, and PDF reports.
