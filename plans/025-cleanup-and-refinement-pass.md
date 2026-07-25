# 025 — Cleanup and Refinement Pass

## Status

Proposed on 2026-07-25 against `main` at `6368d9f` (clean working tree).

This is a maintenance pass, not a feature or capability change. It fixes the
currently red `main` CI, removes verified-dead code and configuration,
de-duplicates the local API's artifact persistence, and documents architecture
facts that the README currently states incorrectly. Solver numerics, units,
coordinate conventions, file formats, routes, and product limits are unchanged
except where an increment names the change and justifies it.

Plan [024](024-codebase-health-and-solver-capability-roadmap.md) remains the
capability roadmap. This plan deliberately does **not** start 024's large
items (backend retirement, `CadViewer.tsx` decomposition, dependency cohort
upgrades, raw-export work); it takes only the increments that are low-risk,
independently verifiable, and unblock a green CI.

## Established baseline

Commands available: `pnpm build:core`, `pnpm build`, `pnpm typecheck`,
`pnpm test`, `pnpm build:cloudflare`, `pnpm --filter @opencae/web check:bundle`,
`node scripts/verify-cloudflare-config.mjs`. There is **no formatter and no
ESLint** in this repo; "run formatting/linting" resolves to `pnpm typecheck`
plus the package `lint` scripts, which are themselves `tsc --noEmit`.

Measured baseline (this machine, after `pnpm build:core`):

| Check | Result |
| - | - |
| `pnpm typecheck` | pass |
| `pnpm test` | **6 failed / 1487 passed (147 files, 2 failed)** |
| `pnpm build:core` | pass |

The same 6 failures reproduce in GitHub Actions on `main`
(run 29886308340, and the run before it) — `main` CI is red, and has been for
at least two merges. Note that `pnpm test` without a prior `pnpm build:core`
produces 13 failures rather than 6; the extra 7 are stale `dist/` artifacts,
not defects. CI builds core packages first.

The 6 real failures:

1. `apps/opencae-web/src/performanceRewrite.test.ts` — asserts the literal
   string `resultFields={resultFieldsForUi}` is present in `WorkspaceApp.tsx`.
   The component now passes `resultFields={resultDisplayEligible ? resultFieldsForUi : []}`
   (line 2571) and `resultFields={visibleResultFieldsForUi}` (line 2531). The
   invariant the test exists to protect — playback fields flow from the
   memoized `resultFieldsForUi`, never from raw per-frame state — still holds.
   The assertion is stale source-text matching, not a product defect.
2–6. `libs/opencae-solve-pipeline/src/goldenParity.test.ts` — all five golden
   fixtures. Two distinct causes:
   - Physical values differ from the recorded cloud fixtures by **1.7e-12 to
     2.7e-11 relative** while `RELATIVE_TOLERANCE = 1e-12`. The CG stopping
     criterion is `SPARSE_ALGEBRA_POLICY.defaultRelativeResidualTolerance = 1e-10`
     (`packages/solver-cpu/src/sparse-policy.ts`), so the solution vector is
     only determined to ~1e-10 relative. **The gate demands two orders of
     magnitude more agreement than the algorithm guarantees.** The observed
     deltas are consistent with the intended CG-criterion change in `63daf73`
     ("Fix relative CG convergence"), whose fixtures were never revisited.
   - `beam-dynamic` fails on `diagnostics[6].convergence[1].iterations: 413 != 405`.
     A CG iteration count is discrete solver telemetry, criterion-dependent by
     construction; comparing it under a 1e-12 *relative* float tolerance is a
     category error.

## Verified findings driving the work

- **`packages/solver-wasm` is a one-line placeholder** (`export const SOLVER_WASM_PLACEHOLDER = true;`).
  Nothing imports it. It is built by `build:core`, by CI as its own step, and
  asserted present by `scripts/verify-cloudflare-config.test.mjs`. Plan 024
  §Release 3 already resolves to delete it.
- **The web app never calls the Fastify API.** The only `fetch` calls in
  `apps/opencae-web/src` are `workers/gmshWasmBinary.ts` (wasm manifest/binary)
  and `report/reportPdf.ts` (bundled font). `apps/opencae-api` (990-line
  `server.ts`), `services/*`, and the `libs/opencae-{db,jobs,storage}` chain
  are reachable only via `pnpm dev` + direct HTTP, not from the product. The
  README does not say this; it presents the API as part of the workflow. This
  plan **documents** the fact and does **not** delete the backend — 024 wants a
  route-by-route parity inventory first, and deleting ~6.6k lines of tested
  source is not a cleanup-pass decision.
- **`apps/opencae-api/src/server.ts` duplicates its own persistence logic.**
  `persistImportedResults` and `persistSampleResults` are near-identical but
  disagree on the default report key (`reports/${runId}.html` vs
  `reports/${runId}/report.html`) for the same concept, and only one writes a
  PDF. `projectWithImportedResultRefs` hardcodes a third copy of the same two
  paths. The `/api/projects/:projectId/report{,.pdf}` and
  `/api/runs/:runId/report{,.pdf}` handlers are four near-copies.
- **Mutating API routes carry rate limits inconsistently.** `POST /api/projects`,
  `/uploads`, `/mesh`, `/runs`, and `PUT /api/studies/:studyId` use
  `mutatingRateLimit`; `PUT /api/projects/:projectId`, `POST /api/studies/:studyId/materials`,
  `/supports`, and `/loads` mutate persistent state with no limit at all.
- **`POST /api/studies/:studyId/loads` does not validate `value` numerically.**
  A non-finite or missing-but-present `value` (`NaN`, `Infinity`, `"5"`) reaches
  `parameters.value` unchecked; `?? 500` only catches `undefined`.
- **The debug mesh-proof harness loads in every production session.**
  `main.tsx` dynamically imports `workers/meshHarness` whenever
  `VITE_WASM_MESHING !== "0"`, i.e. always in production. Its only consumers
  (`scripts/verify-wasm-mesh-browser.mjs`, `scripts/verify-offline-pwa.mjs`)
  always navigate with a `?meshProof=…` query parameter, exactly as
  `solveBenchHarness` is already gated on `?solveBench`.
- **Four dead CSS rule selectors**: `.list-block`, `.mock-backend`,
  `.report-list`, `.simulation-group` — no source reference (363 classes
  scanned; every other class and all 89 custom properties are live except the
  z-index tokens below).
- **The z-index token scale does not describe the app.** `tokens.css` declares
  `--z-base: 0`, `--z-modal: 50`, `--z-start-screen: 100`; none are used, while
  `app.css` hardcodes 20, 30, 35, 40, 120, 1000, 9999 for the layers that
  actually stack. Only `--z-viewer-overlay` and `--z-log-drawer` are wired up.
- **A comment in `app.css:464` points at `tokens.css` as if it were absent**
  from the styles directory; `tokens.css` lives in `src/theme/`, not
  `src/styles/`. The comment reads as stale.
- **README inaccuracies**: it lists `data/*` as holding an `uploads` directory
  (there is none), and describes the API as serving the workflow.
- `packages/viewer` is imported by nothing outside itself (it has its own
  passing tests). 024 wants adoption-or-deletion decided on parity evidence.
  **Flag only; no change here.**

Dependency posture: 24 packages are behind. Everything meaningful is a major
bump (react 18→19, three 0.171→0.185, vite 6→8, zod 3→4, typescript 5→7,
vitest 3→4, `@fastify/*` 10→11, jspdf 3→4, lucide 0.4→1.x). Only `fastify`
(5.8.5→5.10.0) and `tsx` (4.21→4.23) are in-range patch/minor bumps on
already-tested surfaces. `wrangler` 4.85→4.114 is in-range but is the deploy
tool and cannot be verified here beyond config verification, so it is deferred.

## Stages

Each stage is one commit, and each ends with `pnpm typecheck` plus the tests
touching it. The full suite and `pnpm build` run after the last stage.

### Stage 1 — Make `main` CI honest and green (correctness)

1. `goldenParity.test.ts`: separate **discrete solver telemetry** from
   **physical-value parity**. Compare iteration counts and other integer
   convergence counters under an explicit, named, documented policy instead of
   the float tolerance; keep them asserted (they must stay in the same order of
   magnitude), not dropped.
2. `goldenParity.test.ts`: set the physical-value relative tolerance to a value
   consistent with the CG stopping criterion, deriving it from
   `SPARSE_ALGEBRA_POLICY.defaultRelativeResidualTolerance` rather than
   hardcoding a second magic number, and document why a tighter gate is not
   physically meaningful. This is an intentional, named test-gate change.
3. `performanceRewrite.test.ts`: replace the stale literal with an assertion
   that matches the invariant (every `resultFields=` prop the workspace passes
   to the viewer is derived from `resultFieldsForUi`), so a real regression
   still fails but a conditional-prop refactor does not.

Acceptance: `pnpm test` is green after `pnpm build:core`, no assertion was
deleted, and both re-tolerance decisions are justified in code comments.

### Stage 2 — Local API structural cleanup (backend)

1. Extract one `persistResultBundle` helper owning a single canonical result and
   report key policy, and one `reportArtifactKeys(projectId, runId)` used by
   `projectWithImportedResultRefs` too. Keep the existing canonical keys for
   the import path — the sample path's differing key is the one that changes,
   and it must be named as such.
2. Collapse the four report handlers to two shared handler builders (HTML and
   PDF) parameterized by how the run is resolved, preserving every existing
   status code, header, and message verbatim.
3. Apply `mutatingRateLimit` to the four unprotected mutating routes.
4. Validate `value`, and the vector/point inputs, at the `POST /loads`
   boundary: reject non-finite and non-number values with a 400 in the existing
   error shape rather than persisting them.
5. Fix the broken indentation in the `/api/sample-project` handler.

Acceptance: `apps/opencae-api` tests pass; response bodies, status codes, and
artifact keys are unchanged except the sample report key, which is documented.

### Stage 3 — Remove verified-dead code and configuration

1. Delete `packages/solver-wasm` and every reference: `build:core`, the CI
   build step, `scripts/verify-cloudflare-config.test.mjs`'s expected package
   list, and the `docs/core/{ARCHITECTURE,AGENTS}.md` mentions. Leave the
   historical `plans/*` and `docs/cloud-retirement.md` records intact — they
   describe what was true when written.
2. Gate the `meshHarness` import on the `?meshProof=` parameter, matching the
   existing `solveBenchHarness` pattern, and update the comment. Both
   verification scripts already pass that parameter.
3. Delete the four dead CSS rule selectors.

Acceptance: `pnpm build:core`, `pnpm typecheck`, `pnpm test`,
`node scripts/verify-cloudflare-config.mjs`, and `pnpm build:cloudflare` pass;
`check:bundle` still passes and the harness chunk no longer loads unrequested.

### Stage 4 — UI consistency: one stacking scale

Replace the hardcoded `z-index` values in `app.css` with named tokens whose
values are **exactly the numbers already in use**, so nothing renders
differently, and retire the three aspirational tokens that describe layers the
app does not have. Flag — do not change — that `.workflow-modal-backdrop` (30)
and `.validation-gallery-backdrop` (120) are the same conceptual layer at
different depths, with `.condition-menu` (35) and `.shortcut-popover` (40)
between them.

Acceptance: every computed `z-index` is byte-identical to before; `appCss.test.ts`
passes; the layer order is readable in one place.

### Stage 5 — Dependencies and documentation

1. `fastify` 5.8.5→5.10.0 and `tsx` 4.21→4.23 (in-range, tested surfaces).
   Defer every major and `wrangler` with reasons recorded.
2. README: state that the production web app is fully browser-local and the
   Fastify API is a local development/reference backend the web client does not
   call; correct the `data/*` directory list; keep every deploy instruction as
   is.
3. Fix the stale `tokens.css` reference in `app.css`.

Acceptance: `pnpm typecheck`, `pnpm test`, `pnpm build` pass; README claims
match the code.

## Explicitly out of scope

Backend retirement; `CadViewer.tsx` / `WorkspaceApp.tsx` / `RightPanel.tsx`
decomposition; `packages/viewer` adoption-or-deletion; the remaining ~250
source-text guard assertions in `performanceRewrite.test.ts` (plan 005);
major dependency cohorts; solver algorithm or tolerance changes; any change to
units, coordinate conventions, DOF limits, file formats, or result provenance.
