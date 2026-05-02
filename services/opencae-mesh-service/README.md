# OpenCAE Mesh Service

`@opencae/mesh-service` owns the local mesh-generation boundary.

The current service generates deterministic mesh summaries for coarse, medium, fine, and ultra presets. Summaries include node counts, element counts, warnings, quality labels, and analysis sample counts used by local solver paths.

Meshes are generated artifacts. They do not become the source of truth for loads, constraints, contacts, or named selections; those remain bound to CAD topology references.
