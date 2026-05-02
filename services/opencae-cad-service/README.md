# OpenCAE CAD Service

`@opencae/cad-service` owns the CAD inspection boundary used by the local API.

The current implementation writes stable display metadata and topology references for seeded and uploaded models. STEP and STP uploads can be represented as selectable native CAD imports in the local viewer, while STL and OBJ uploads use visual mesh previews when mesh content is available.

Study data binds loads, supports, and named selections to CAD topology references rather than generated mesh ids. Native Open CASCADE-backed inspection can replace this package later without changing the study model.

Open CASCADE and related CAD import components are separately licensed third-party software when present. See [../../THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) for attribution and license details.
