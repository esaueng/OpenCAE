# OpenCAE Core Cloud golden solve fixtures

Frozen request/response pairs for the deployed OpenCAE Core Cloud runner, recorded so
the upcoming local (in-browser) solve pipeline can be compared against the production
cloud contract bit-for-bit. `src/lib/coreCloudGolden.test.ts` characterizes these
fixtures and is the executable spec a replacement pipeline must satisfy.

## Provenance

- Runner: `services/opencae-core-cloud` built from the opencae-core repo at the pinned
  production ref in `services/opencae-core-cloud/OPENCAE_CORE_REF`
  (`5fff27782df894ecf28d65097f63461d69771f16`), runnerVersion `0.1.6`,
  coreVersion `0.1.5`, native gmsh `4.15.2-git` available (the bracket case was meshed
  through the real gmsh `.geo` dispatch path, same as production).
- Requests: built by the production request builder
  `openCaeCoreCloudSolveRequest()` in `apps/opencae-web/src/lib/api.ts` — the exact
  body the web app POSTs to `/api/cloud-core/runs`, which the Worker
  (`apps/opencae-web/worker/index.ts`) forwards verbatim to the runner's `/solve`.
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

Only re-record when the pinned production runner contract intentionally changes:

1. Check out opencae-core at the ref in `services/opencae-core-cloud/OPENCAE_CORE_REF`
   (use a separate worktree), `pnpm install && pnpm build` there.
2. `PORT=8080 CORE_CLOUD_API_KEY=golden-local node services/opencae-core-cloud/dist/server.bundle.js`
   (native `gmsh` must be on PATH for the bracket case; `/health` reports
   `gmshAvailable`).
3. In this repo: `pnpm exec tsx scripts/record-core-cloud-golden.mts`.
4. Run the characterization test and update it alongside any intentional contract
   change: `pnpm test coreCloudGolden`.
