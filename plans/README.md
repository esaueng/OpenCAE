# OpenCAE Advisor Plans

Two advisory runs are indexed here:

- **Run 1 — 2026-06-12**, base commit `3a67db9`, standard read-only survey (plans 001–005). Written when the repo lived at `/Users/userzero/codex/opencae-alpha`.
- **Run 2 — 2026-07-01**, standard read-only survey (plans 006–010). Audited **`origin/main` at `d1556f2`** via a detached worktree, because the local checkout's `main` (`4373faf`) is 1 ahead / 34 behind `origin/main` — see plan 006, which must land first. Run 2 re-verified plans 001–005 against `d1556f2`: **all five remain unimplemented and their cited code is unchanged**; they stay TODO.

These plans are written for a fresh executor with no context from the surveys. Each is self-contained.

## Recon Summary

OpenCAE is a pnpm 9 / TypeScript monorepo: React 18 + Vite + three.js web app (`apps/opencae-web`) fronted in production (cae.esau.app) by a Cloudflare Worker (`apps/opencae-web/worker/index.ts`) that proxies solves to a containerized solver (`services/opencae-core-cloud`, Durable Object + R2); a Fastify local-dev API (`apps/opencae-api`); shared libs (`libs/*`); and a sibling `../opencae-core` workspace supplying `@opencae/core*` solver packages, pinned by `services/opencae-core-cloud/OPENCAE_CORE_REF`. CI (Node 22) clones the pinned sibling, installs frozen, builds core packages, runs the Cloudflare/runner verify scripts, then `pnpm typecheck` and `pnpm test`.

Primary verification gates for implementation plans:

```sh
pnpm verify:cloudflare-config
pnpm verify:runner-version
pnpm typecheck
pnpm test
```

Full build/deploy gates when a plan touches build or Cloudflare behavior: `pnpm build`, `pnpm deploy:cloudflare:dry-run` (but see plan 003 about `build:core`'s unfrozen install).

Production state checked 2026-07-01: `https://cae.esau.app/api/cloud-core/health` reports runner 0.1.5, core 0.1.3, solver-cpu 0.1.4 — production matches `origin/main`'s pins.

## Prioritized Findings

| # | Finding | Category | Impact | Effort | Risk | Evidence |
| - | - | - | - | - | - | - |
| 1 | Local `main` is a stale divergent line (1 ahead / 34 behind `origin/main`); its unique commit `4373faf` holds real solver-adapter fixes absent from production, and the checkout lacks a month of production fixes (render, a11y, CI, security module, STEP writer). Both sides conflict in `libs/opencae-core-adapter`. | repo state / correctness | High | M | Med | `git rev-list --left-right --count main...origin/main` → `1 34`; `git diff --stat 5da43e0 origin/main -- libs/opencae-core-adapter/` |
| 2 | Result provenance classification can mark non-Core-Cloud actual-mesh local solves as `production_fea`, driving bare `complete` run status. *(Run 1; re-verified unchanged at `d1556f2`.)* | correctness / truthfulness | High | M | Med | `libs/opencae-schema/src/index.ts:390-399`, `apps/opencae-api/src/server.ts` |
| 3 | Unbounded `Math.min/max(...spread)` over result-field arrays crashes (V8 arg limit ~65k) on realistic mesh sizes; one site also yields ±Infinity→NaN colors on empty input. Repo already fixed this class once and documents the loop convention (`opencae-core-adapter/src/index.ts:1432`); 5 field-scale sites remain. | correctness | High (latent, growth-triggered) | S | Low | `apps/opencae-web/src/lib/api.ts:353-354`, `apps/opencae-web/src/resultFields.ts:666-667,1012-1013`, `apps/opencae-web/src/components/CadViewer.tsx:2576-2577`, `services/opencae-core-cloud/src/index.ts:302-303,319-320` |
| 4 | Opening/importing a saved project preserves ids and upserts, so an id collision can overwrite the local project. *(Run 1; re-verified unchanged.)* | correctness / data integrity | High | M | Med | `apps/opencae-api/src/server.ts:177`, `libs/opencae-db/src/index.ts` |
| 5 | CI never runs the production web build (`vite build`) or the existing 175 KB bundle-budget scripts — build breakage and budget drift surface at deploy time. | DX / release integrity | Med | S | Low | `.github/workflows/ci.yml` (job ends at typecheck+test); `scripts/check-web-bundle-budget.mjs:7` |
| 6 | Stale run-completion continuation: after `await getResults(...)`, `WorkspaceApp` applies results and navigates without re-checking the run is still current; cancel closes the stream but can't stop the in-flight continuation → superseded results displayed as current. | correctness / truthfulness | Med | M | Low | `apps/opencae-web/src/WorkspaceApp.tsx:1124-1170,1174-1193` |
| 7 | Worker Core Cloud run orchestration: non-atomic R2 `head`→`put` start claim; event streams served as snapshots. *(Run 1; re-verified unchanged at `worker/index.ts:273-275`.)* | reliability | Med | M | Med | `apps/opencae-web/worker/index.ts:269-277` |
| 8 | The cantilever accuracy gate's fixture is schema-invalid for its dynamic variant and hidden by an `as Study` cast — the dynamic benchmark certifies a configuration the product can't produce, and the cast swallows future fixture drift. | tests / accuracy guardrails | Med | S | Low | `apps/opencae-web/src/workers/localCantileverAccuracy.test.ts:29-68,95` |
| 9 | Local build scripts use an unfrozen install path while CI is frozen. *(Run 1; re-verified unchanged at `package.json:11`.)* | DX / release integrity | Med | S | Low | `package.json:11`, `scripts/ensure-opencae-core.mjs` |
| 10 | Source-text guard tests remain brittle. *(Run 1; re-verified — `performanceRewrite.test.ts` still asserts source strings.)* | tests / DX | Med | M | Low | `apps/opencae-web/src/performanceRewrite.test.ts` |

## Backlog (vetted, not yet planned)

Real findings that didn't make the plan cut this run — next candidates:

- **RUNNER_VERSION bump toil** spans ~8 synchronized locations across this repo AND the sibling (`RUNNER_VERSION` file, `worker/index.ts` const, two wrangler container tags, two `package.json` image-tag scripts, worker tests, verify scripts; plus the sibling's server consts). The verify scripts catch drift but don't remove the toil. Single-sourcing has a cross-repo component, which is why it isn't a self-contained plan yet. (tech-debt, M)
- **No lint/format tooling** anywhere in the monorepo (no ESLint/Biome/Prettier config, no `lint` script) — notable for a repo with heavy AI-agent contribution. (DX, M)
- **Component decomposition**: `CadViewer.tsx` ~5,861 lines, `RightPanel.tsx` ~1,845 lines (7 inline sub-panels with a natural file-per-panel split), `WorkspaceApp.tsx` ~1,588. Integration behavior in the JSX is untested; decompose AFTER product-level E2E coverage exists (see Direction). (tech-debt, L)
- **STEP writer topology validation**: `libs/opencae-step` tests check entity presence, not face-edge-vertex loop connectivity/orientation — invalid-but-parseable STEP output is the risk class. (tests, M)
- **React 19 + @react-three/fiber 9 coupled migration** (with drei/@types) — not urgent; verify current ecosystem status online before scheduling. (dependencies, L, fix-risk High)
- Micro-hardening adjacent to plan 004, fold in when 004 executes: validate `runId` path-segment format in `worker/index.ts:151-153`; add `X-Frame-Options: DENY` beside the existing `frame-ancestors 'none'`.
- Document (or remove) the `fast-uri: 3.1.2` pnpm override — likely a past advisory pin; verify online. (dependencies, S)

## Direction Options (Run 2)

Grounded options for what to build next — maintainer's call, not ranked against the bug findings:

1. **Uploaded-CAD cloud solves, end to end.** The routing exists (`cloudGeometrySourceForStudy`, `libs/opencae-core-adapter/src/index.ts:158`, consumed at `apps/opencae-web/src/lib/api.ts:565` with kinds `sample_procedural | uploaded_cad | uploaded_mesh | structured_block`), but validation docs still gate larger imported parts on a real Core volume-mesh artifact before cloud dispatch, and meshing failures on real-world CAD lack a user-facing feedback loop. This is the gap between "demo with three samples" and "engineers solve their own parts" — the highest product leverage on the evidence. Risks: Gmsh failure modes on dirty CAD become your support burden; needs mesh-quality reporting so users know fidelity. Effort: L (spans web UX, worker, container, sibling).
2. **Execute the accuracy roadmap's Phase 1 (truthfulness) via plan 001.** `docs/validation/quality-accuracy-plan.md` remains the maintainer's own intent doc; plan 001 is its highest-leverage slice and is already fully specified. Effort: M.
3. **Product-level open/save/import round-trip E2E suite** (reaffirmed from Run 1). It is also the prerequisite that makes the big-component decomposition and plan 002's collision work safe to verify. Effort: M.
4. **Solver capability bets (later):** modal/frequency analysis (natural next analysis type; mostly sibling-repo eigensolver work, L–XL) and the WebGPU local tier (`libs/opencae-solver-webgpu` is capability-detection only today; XL). Sequence after 1–3.

## Execution Order

1. `006-reconcile-local-main-with-origin-main.md` — first; unblocks everything and ships `4373faf`'s fixes toward production.
2. `001-tighten-result-provenance-taxonomy.md`
3. `007-bound-result-field-extent-computation.md`
4. `002-make-project-import-collision-safe.md`
5. `008-ci-build-web-and-enforce-bundle-budget.md`
6. `009-guard-stale-run-completion-continuations.md`
7. `010-make-cantilever-accuracy-fixture-schema-valid.md`
8. `003-make-core-builds-reproducible.md`
9. `004-harden-cloud-worker-run-orchestration.md`
10. `005-replace-source-text-guard-tests.md`

Dependency notes:

- Plans 007–010 are written against `origin/main` (`d1556f2`) content and assume 006 has landed in the working checkout (006 also delivers CI and the `typecheck` script to the local line).
- Plan 007 note: 006's merge should already fix the adapter's frame-spread site; 007 verifies and skips it if so.
- Plan 001 before new labeling/report work; plan 005 after 001/004 (unchanged from Run 1).
- Plans 008, 009, 010 are mutually independent.

## Status

| Plan | Status | Owner Notes |
| - | - | - |
| 001 Tighten result provenance taxonomy | TODO (re-verified 2026-07-01) | Highest-leverage correctness fix; classifier unchanged at `d1556f2`. |
| 002 Make project import collision-safe | TODO (re-verified 2026-07-01) | `upsertProject(importedProject)` still id-preserving. |
| 003 Make Core builds reproducible | TODO (re-verified 2026-07-01) | `build:core` still unfrozen. |
| 004 Harden Cloud Worker run orchestration | TODO (re-verified 2026-07-01) | `head`→`put` claim unchanged; fold in backlog micro-hardening. |
| 005 Replace source-text guard tests | TODO (re-verified 2026-07-01) | After 001/004. |
| 006 Reconcile local main with origin/main | TODO | Do first. Conflict surface = two adapter files; preserves `4373faf`. |
| 007 Bound result-field extent computation | TODO | S-effort; latent crash class already seen once in this repo. |
| 008 CI: build web + enforce bundle budget | TODO | Wires existing scripts into CI; no new infrastructure. |
| 009 Guard stale run-completion continuations | TODO | Truthfulness: superseded results must not display as current. |
| 010 Schema-valid cantilever accuracy fixture | TODO | Removes the `as Study` cast that silenced the old tsc errors. |

Run 2 was non-interactive: plans 006–010 are the top findings by leverage (impact ÷ effort, confidence-weighted), selected by default per the advisor skill's non-interactive rule rather than by maintainer choice. Re-cut as desired.

## Considered And Rejected

Run 1 (2026-06-12):

- Report truthfulness follow-up — post-service already labels schematic visuals, escapes HTML, includes provenance.
- Generic storage traversal hardening — `getLocalPath` already rejects absolute/parent-traversal keys; symlink hardening low-leverage for the localhost threat model.
- Broad CAE accuracy benchmark work — `docs/validation/quality-accuracy-plan.md` already covers it.

Run 2 (2026-07-01) — verified against the code and rejected; do not re-audit without new evidence:

- "ParametricPartBuilder is not exposed in the UI" — refuted: rendered at `apps/opencae-web/src/components/RightPanel.tsx:246`.
- "Base64 upload bypasses the 5 MB body limit via decoded amplification" — refuted: base64 decodes to ~0.75× the encoded size; `bodyLimit` bounds the decoded buffer below the limit.
- CORS allowing requests without an `Origin` header (`apps/opencae-api/src/server.ts`) — standard behavior; CORS does not protect non-browser clients; allowlist is localhost-only.
- Client event-stream payloads lack zod validation (`api.ts:446-454`) — the claimed failure path is wrong (completion uses the closure's `response.run.id`, not event fields) and consumers are defensive; low value.
- `style-src 'unsafe-inline'` in the CSP — real observation, but removal requires restyling work disproportionate to risk for this app today.
- R2 artifact HMAC/integrity tagging — requires an attacker who already holds R2 credentials; out of threat model.
- Lowering the 25× coordinate-space diagnostic threshold (`resultFields.ts`) — the threshold deliberately targets the 1000× m↔mm class; lower values would false-positive on legitimate geometry.
- PDF string-escaping hardening in post-service — `pdfEscape` already handles `\`, `(`, `)` and non-ASCII; remaining concerns speculative.
- "wrangler.static / wrangler.local-first configs are vestigial" — refuted: README documents both as intentional separate deploy paths.
- Symlink hardening in storage — re-affirmed Run 1's rejection; no new evidence.

## Not Audited (Run 2)

- The sibling `../opencae-core` implementation (only its top-level intent docs were read for direction grounding).
- Live Cloudflare resources beyond the two public health endpoints; R2 contents; production logs.
- Browser-rendered UX / visual regression; dependency CVEs via online audit (`pnpm audit` not run — flagged "verify online" where relevant).
- Deep line-by-line coverage of `CadViewer.tsx` render internals and the Worker's every branch (hotspot-weighted standard-effort pass, four parallel auditors + manual vetting of every reported finding).
