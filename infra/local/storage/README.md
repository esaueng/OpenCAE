# Local Storage

The local storage backend writes artifacts under `data/artifacts` using `FileSystemObjectStorageProvider`.

Stored artifacts include uploaded model files, display models, mesh summaries, solver input files, solver logs, result JSON bundles, HTML reports, and PDF reports. SQLite metadata stores references to these artifacts rather than embedding every runtime artifact in the database.
