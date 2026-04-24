# OpenCAE Architecture

OpenCAE is organized around service boundaries that can start as in-process mocks and later become native or external compute services.

- CAD entities are the source of truth.
- Mesh entities are generated artifacts.
- Results are immutable study-run artifacts.
- Loads, supports, contacts, and named selections bind to CAD topology references.

The local MVP uses React, Fastify, SQLite, filesystem artifact storage, an in-memory job queue, and Server-Sent Events for run progress.
