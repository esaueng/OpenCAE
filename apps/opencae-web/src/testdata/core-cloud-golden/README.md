# OpenCAE Core Cloud golden solve fixtures

Frozen request/response pairs for the RETIRED OpenCAE Core Cloud runner (cloud
solve infrastructure removed July 2026 — see `docs/cloud-retirement.md`).
They are permanent keepers: they encode the production cloud contract the
local (in-browser) solve pipeline must keep reproducing bit-for-bit.
`src/lib/coreCloudGolden.test.ts` characterizes these fixtures, and
`libs/opencae-solve-pipeline/src/goldenParity.test.ts` replays every fixture's
solve through the browser pipeline (`@opencae/solve-pipeline`) and requires
the recorded response to be reproduced (1e-12 relative numeric tolerance; the
provenance `runnerVersion` differs by design).

## Provenance

- Runner: the Core Cloud runner service (`services/opencae-core-cloud` in the
  sibling opencae-core repo; this repo's mirror of it was deleted with the
  cloud retirement) built at the ref recorded in each fixture's `meta.coreRef`
  (`5fff27782df894ecf28d65097f63461d69771f16`), runnerVersion `0.1.6`,
  coreVersion `0.1.5`, native gmsh `4.15.2-git` available (the bracket case was meshed
  through the real gmsh `.geo` dispatch path, same as production).
- Requests: built by the then-production request builder
  `openCaeCoreCloudSolveRequest()` — the exact body the web app POSTed to
  `/api/cloud-core/runs`, which the Worker forwarded verbatim to the runner's
  `/solve`. A frozen copy of that builder lives in
  `scripts/record-core-cloud-golden.mts` (the client original was removed in B4a,
  the Worker route in B4b).
- Responses: the full `/solve` JSON body (HTTP 200) from that runner.

## Cases

| Fixture | Sample | Analysis | Notes |
| --- | --- | --- | --- |
| `cantilever-static.json` | cantilever | static_stress | default (medium) mesh preset |
| `beam-static.json` | plate ("Beam Demo") | static_stress | default (medium) mesh preset |
| `bracket-static.json` | bracket | static_stress | gmsh `.geo` procedural dispatch, linear elements (production `elementOrder: 1` override) |
| `cantilever-dynamic.json` | cantilever | dynamic_structural | coarse preset, endTime 0.05 s, 11 frames |
| `beam-dynamic.json` | plate ("Beam Demo") | dynamic_structural | coarse preset, endTime 0.05 s, 11 frames |

Dynamic cases deviate from the sample defaults (medium preset, endTime 0.1 s) only to
keep fixtures under the 2 MB budget; both overrides are ordinary user-selectable
settings, so the request contract is unchanged.

## File format

```json
{ "meta": { "coreRef", "runnerVersion", "coreVersion", "recordedAt", "case" },
  "request": { ...exact /solve request body... },
  "response": { ...exact /solve response body... } }
```

Files are single-line JSON on purpose: they are frozen machine-compared fixtures and
pretty-printing the numeric arrays roughly triples their size.

## Re-recording

The cloud runner is retired, so re-record only if the frozen contract itself must be
regenerated (e.g. to extend fixture coverage from the same archived runner):

1. Check out the sibling opencae-core repo at the ref in the fixtures' `meta.coreRef`
   (use a separate worktree), `pnpm install && pnpm build` there.
2. `PORT=8080 CORE_CLOUD_API_KEY=golden-local node services/opencae-core-cloud/dist/server.bundle.js`
   in that opencae-core worktree (native `gmsh` must be on PATH for the bracket case;
   `/health` reports `gmshAvailable`).
3. In this repo: `pnpm exec tsx scripts/record-core-cloud-golden.mts`
   (set `CORE_CLOUD_GOLDEN_CORE_REF` to the runner's ref so `meta.coreRef` stays accurate).
4. Run the characterization test and update it alongside any intentional contract
   change: `pnpm test coreCloudGolden`.
