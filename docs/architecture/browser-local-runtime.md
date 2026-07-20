# Browser-local runtime boundary

The production web application owns project editing, meshing, solving, result persistence, and reporting in the browser. These operations must not probe an undeployed server route before using their local implementation.

## Retired route inventory

| Retired browser route | Browser-local owner | Characterization |
| --- | --- | --- |
| `POST /api/sample-project/load` | `createLocalSampleProject` | sample and analysis-type fixtures in `lib/api.test.ts` |
| `POST /api/projects` | `createLocalBlankProject` | blank-project coverage in `lib/api.test.ts` and `localProjectFactory.test.ts` |
| `POST /api/projects/import` | `openLocalProjectPayload` | import and migration coverage in `lib/api.test.ts` and `projectFile.test.ts` |
| `POST /api/projects/:id/uploads` | `createLocalUploadResponse` plus STEP/STL browser inspection | upload, cancellation, STEP, STL, and worker coverage in `lib/api.test.ts` and worker tests |
| `PUT /api/projects/:id` | immutable local project update | rename coverage in `lib/api.test.ts` |
| `POST /api/studies/:id/mesh` | Gmsh WASM or explicit preset estimate | mesh, quality rejection, repair, and convergence coverage in `lib/api.test.ts` and `lib/wasmMeshing.test.ts` |
| `POST /api/studies/:id/materials` | local study mutation | material/process coverage in `lib/api.test.ts` |
| `POST /api/studies/:id/supports` | local study mutation | support coverage in `lib/api.test.ts` |
| `PUT /api/studies/:id` | local study mutation | study-update coverage in `lib/api.test.ts` |
| `POST /api/studies/:id/loads` | local study mutation | structural and advanced-load coverage in `lib/api.test.ts` |
| `POST /api/studies/:id/runs` | local solve worker | static, dynamic, modal, cancellation, progress, and persistence coverage in `lib/api.test.ts` and worker tests |
| `GET /api/runs/:id/results` | memory cache and IndexedDB result store | completion/reload coverage in `lib/api.test.ts` and `lib/localResultsStore.test.ts` |
| `POST /api/runs/:id/cancel` | local run record and worker cancellation | terminal-event coverage in `lib/api.test.ts` |
| `GET /api/runs/:id/stream` | local event subscription | progress/completion/error coverage in `lib/api.test.ts` |

Unknown and historical run identifiers fail with an explicit local-history message. They are never sent to a retired API.

## Retained Worker route

`/api/project-backups/*` remains a production Cloudflare Worker boundary for opt-in encrypted recovery. It is deliberately isolated in `cloudBackup.ts`; project contents are encrypted before upload, and the normal local workflow does not depend on it.

## Guard

Production browser source may contain `/api/` only in the encrypted-backup module. Route-contract tests and repository search enforce that the local workflow does not regain a server-first fallback.
