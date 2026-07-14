# OpenCAE Advisor Plans

Four advisory runs are indexed here:

- **Run 1 — 2026-06-12**, base commit `3a67db9`, standard read-only survey (plans 001–005). Written when the repo lived at `/Users/userzero/codex/opencae-alpha`.
- **Run 2 — 2026-07-01**, standard read-only survey (plans 006–010). Audited **`origin/main` at `d1556f2`** via a detached worktree, because the local checkout's `main` (`4373faf`) is 1 ahead / 34 behind `origin/main` — see plan 006, which must land first. Run 2 re-verified plans 001–005 against `d1556f2`: **all five remain unimplemented and their cited code is unchanged**; they stay TODO.
- **Run 3 — 2026-07-02**, standard engineering/CAE-validity survey (plans 011–014). Audited the **solver itself**: the sibling OpenCAE-Core checkout at the pinned ref `08ca7a6` (byte-identical to the production runner 0.1.5) plus the open-cae post-processing chain at `d1556f2`. Four parallel numerical-methods audits plus independent hand checks (Timoshenko deflection/stress, first-bending frequency, HRZ mass-fraction conservation). Headline: **the production solver's math is sound — the gaps are in the verification harness** (gates run in no CI, single-configuration benchmark, no gmsh-path gate, no unit round-trip).
- **Run 4 — 2026-07-05**, local-first solver migration plan (plans 015–016). Split the revised fully-local solver memo into an executable browser-solver parity track and a WASM meshing/offline-assets track. Plan 015 is already in progress with a dynamic step-budget preflight slice; plan 016 remains gated by Gmsh WASM viability and licensing.
- **Run 5 — 2026-07-09**, repo consolidation (plan 017). Imported OpenCAE Core packages into this monorepo, removed the sibling checkout/pin bootstrap, and wired Core package tests into this repo's CI.
- **2026-07-10**, mesh-failure UX (plan 018, from a live failing upload rather than an advisor run). A nominal-solid STEP (428 faces) failed 3D meshing; the automatic repair sew destroyed the imported volume and the surfaced error pointed at a Fix open surfaces button that never renders for parts inspected as "solid" at upload.
- **2026-07-10**, product feature (plan 020, maintainer request). One-click professional PDF simulation report from the results page: full setup (geometry, material, BCs, mesh, solver) + results with contour figures, built on the honest-results formatters, lazy-loaded jsPDF, and a new viewer capture seam.

These plans are written for a fresh executor with no context from the surveys. Each is self-contained.

## Recon Summary

OpenCAE is a pnpm / TypeScript monorepo: React 18 + Vite + three.js web app (`apps/opencae-web`) fronted in production (cae.esau.app) by a Cloudflare Worker (`apps/opencae-web/worker/index.ts`) that serves static assets and health checks while solves run locally in the browser; a Fastify local-dev API (`apps/opencae-api`); imported OpenCAE Core packages (`packages/*`); and shared libs/services/runners (`libs/*`, `services/*`, `runners/*`). CI (Node 22) installs frozen, builds and tests Core packages, runs the Cloudflare config gate, then `pnpm typecheck` and `pnpm test`.

Primary verification gates for implementation plans:

```sh
pnpm verify:cloudflare-config
pnpm typecheck
pnpm test
```

Full build/deploy gates when a plan touches build or Cloudflare behavior: `pnpm build`, `pnpm deploy:cloudflare:dry-run`.

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
| 11 | The solver accuracy gates run in **no CI**: the sibling repo has no `.github/` at all, and open-cae CI builds sibling packages but cannot reach its service tests (`pnpm-workspace.yaml` includes only `../opencae-core/packages/*`; `test:core-cloud` filters to the open-cae MIRROR because both service packages are named `@opencae/core-cloud`). A solver regression merges silently. *(Run 3, VERIFIED.)* | validation / reproducibility | High | M | Low | sibling: no `.github/`; `pnpm-workspace.yaml`; both `services/opencae-core-cloud/package.json` name fields |
| 12 | The analytical benchmark covers one configuration — axis-aligned block, bending, end-state-only dynamics. No off-axis load, no natural-frequency gate (oracle ≈ 604 Hz, computable), no smoothed-viz ≤ summary-max invariant test, no stress-stabilization gate, no time-step-adequacy signal (cloud floor 1e-4 s ≈ 17 steps/period on the benchmark). *(Run 3, VERIFIED.)* | validation | High | M | Low | sibling `services/opencae-core-cloud/tests/cantilever-accuracy.test.ts`; `server.ts` SOLVER_LIMITS |
| 13 | The gmsh path (used by real/uploaded geometry — the product's stated direction) has zero quantitative gates, and `gmsh` is installed unpinned in BOTH container Dockerfiles; `examples/plate-with-hole` is actually the beam demo (no holed geometry exists). *(Run 3, VERIFIED.)* | validation / reproducibility | Med-High | L | Low | sibling `Dockerfile:9`, open-cae `services/opencae-core-cloud/Dockerfile:29`, `examples/plate-with-hole/README.md` |
| 14 | Unit boundary is trust-based: `normalizeCoreCloudResultForUi` silently defaults unknown solver-units strings to Pa/m, and no test round-trips solver → normalization → displayed magnitude (accuracy-plan Phase 2.3/2.4, still open). *(Run 3, VERIFIED via the June review + code.)* | correctness / unit integrity | Med | M | Med | open-cae `services/opencae-core-cloud/src/index.ts` (normalize fn), no round-trip test in either repo |

## Engineering Validity — Verified Sound (Run 3)

A CAE audit must state what was checked and found correct, not only defects. Independently verified at sibling `08ca7a6` (= production runner 0.1.5):

- **Static element path is textbook-correct end to end**: isotropic D-matrix (λ, μ), B-matrix with consistent engineering-shear convention in assembly AND recovery, exact von Mises expression, Tet4 Jacobian/volume handling, 4-point Gauss Tet10 quadrature (correct points/weights), Tet4→Tet10 elevation with edge-keyed mid-node dedup matching the element's local numbering, constraint application by row/column elimination with RHS correction, CG with relative-residual criterion (1e-10) and guarded Jacobi preconditioning.
- **Dynamics fundamentals are sound**: Newmark average-acceleration (β=0.25, γ=0.5, correct coefficient algebra and Rayleigh-consistent effective matrix), **HRZ Tet10 mass lumping** (vertex 1/36, edge 4/27 — 4·fV+6·fE = 1 exactly; code comment correctly cites the negative-vertex-mass pathology of row-sum lumping), **modally calibrated Rayleigh damping** (inverse-power ω₁ estimate, ω₂ = 4ω₁ anchoring — an earlier subagent claim of "hardcoded blind defaults" was refuted on read), per-frame reaction computation with a reactionBalance diagnostics trail, zero-mass DOF floor (1e-12).
- **Post-processing honesty invariants hold in code**: summary max stress is the unaveraged element peak computed BEFORE Laplacian smoothing (smoothing is display-only); dynamic summary reaction is the end-state frame; reaction reported as net vector magnitude |Σr|.
- **Benchmark oracles re-derived by hand and confirmed**: Timoshenko tip deflection 0.17578 + 0.00242 = 0.1782 mm; root outer-fiber stress 39.06 MPa; first bending frequency ≈ 604 Hz (matches the "~1.7 ms period" comment).
- **Honest-results work has landed** on origin/main: provenance labels distinguish "Estimate (not FEA)" from "OpenCAE Core Preview (coarse block proxy)" from production; reports carry solver/mesh/provenance and a labeled schematic; the old 770/276 magic UI fallbacks are gone (`neutralValue` now returns 1/0).

### Status of `docs/validation/quality-accuracy-plan.md` items (verified 2026-07-02 at `d1556f2` / `08ca7a6`)

| Item | Status | Note |
| - | - | - |
| C1 heuristic solver invents stress | OPEN (by-policy) | Path still exists, honestly provenanced; Phase-1/plan-001 direction is to gate/relabel, not refine — refinement findings against it are rejected below. |
| C2 fabricated UI fallbacks | LARGELY DONE | `resultFields` uses neutral values now; the seeded bracket demo summary remains as the known demo state. |
| C3 label collapse | DONE | Distinct tier labels in `unitDisplay.ts`. |
| C4 dishonest reports | DONE (modulo schematic) | Provenance/solver/mesh in reports; schematic explicitly labeled "not model geometry". |
| H1 provenance unenforced at persist | OPEN | = plan 001. |
| H3 assumption-based units | PARTIAL | Silent normalize default remains → plan 014; STL-mm and typed-unit schema items remain open (Phase 2.1/2.2). |
| H4 mesh service constant stats | OPEN | Mock by design; real mesh stats arrive via cloud diagnostics only. |
| M1 no quantitative gate in CI | PARTIAL → plan 011 | Gates now EXIST (post-review Tet10 lineage) but run in no CI. |
| M2 no convergence evidence | PARTIAL → plan 012 | Preset sweep asserts counts/deflection, not stress stabilization. |
| M3 alignment checks count-only | OPEN | Backlog. |
| M4 beam-demo text-matching + 0.4 fiber factor | OPEN | Heuristic path; retirement direction. |
| M5 SDOF demo completeness shape | OPEN | Heuristic path; retirement direction. |

## Backlog (vetted, not yet planned)

Real findings that didn't make the plan cut this run — next candidates:

- **RUNNER_VERSION bump toil** spans ~8 synchronized locations across this repo AND the sibling (`RUNNER_VERSION` file, `worker/index.ts` const, two wrangler container tags, two `package.json` image-tag scripts, worker tests, verify scripts; plus the sibling's server consts). The verify scripts catch drift but don't remove the toil. Single-sourcing has a cross-repo component, which is why it isn't a self-contained plan yet. (tech-debt, M)
- **No lint/format tooling** anywhere in the monorepo (no ESLint/Biome/Prettier config, no `lint` script) — notable for a repo with heavy AI-agent contribution. (DX, M)
- **Component decomposition**: `CadViewer.tsx` ~5,861 lines, `RightPanel.tsx` ~1,845 lines (7 inline sub-panels with a natural file-per-panel split), `WorkspaceApp.tsx` ~1,588. Integration behavior in the JSX is untested; decompose AFTER product-level E2E coverage exists (see Direction). (tech-debt, L)
- **STEP writer topology validation**: `libs/opencae-step` tests check entity presence, not face-edge-vertex loop connectivity/orientation — invalid-but-parseable STEP output is the risk class. (tests, M)
- **React 19 + @react-three/fiber 9 coupled migration** (with drei/@types) — not urgent; verify current ecosystem status online before scheduling. (dependencies, L, fix-risk High)
- Micro-hardening adjacent to plan 004, fold in when 004 executes: validate `runId` path-segment format in `worker/index.ts:151-153`; add `X-Frame-Options: DENY` beside the existing `frame-ancestors 'none'`.
- Document (or remove) the `fast-uri: 3.1.2` pnpm override — likely a past advisory pin; verify online. (dependencies, S)
- Run 3 additions: **consistent (area-weighted) surface loads on Tet10 faces** — face forces are currently split equally across selected nodes; total force and reactions stay exact, but local stress at the loaded face is slightly distorted (corner/midside consistent weights differ). Low impact, benchmark-absorbed. (engineering, M) — **rename one of the two `@opencae/core-cloud` packages** (mirror vs sibling name collision behind finding 11's trap). (tech-debt, S) — **empty-selection load behavior**: cloud path throws when a fixed support maps to zero nodes but silently skips zero-force loads; audit whether an empty load *surface set* can produce a quietly unloaded solve. (engineering, S, UNCERTAIN) — **M3 correspondence check**: checksum node ordering between volume mesh and surface fields. (validation, M)

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
8. `011-run-solver-accuracy-gates-in-ci.md` — Part A (sibling CI) can run any time, even before 006.
9. `012-broaden-analytical-solver-benchmarks.md`
10. `014-unit-round-trip-gate-and-strict-units.md`
11. `003-make-core-builds-reproducible.md`
12. `013-gmsh-plate-with-hole-kt-benchmark.md` — after 011 (needs CI with gmsh); the gmsh version pin inside it can ship immediately.
13. `004-harden-cloud-worker-run-orchestration.md`
14. `005-replace-source-text-guard-tests.md`
15. `015-local-first-solver.md` — local-first migration track; can proceed in slices, but upstream solver hooks and persistence gates block full cloud-solve retirement.
16. `016-wasm-meshing-and-offline-assets.md` — after the gmsh-wasm smoke/licensing gate; blocks cloud meshing infrastructure removal.
17. `018-mesh-failure-repair-probe-and-honest-geometry-errors.md` — DONE 2026-07-10.
18. `019-frontal-fallback-before-repair-bail-and-model-keyed-probe-guard.md` — independent; the Frontal fix is the likeliest path to actually meshing the Corning part.
19. `020-results-pdf-report.md` — independent feature; benefits from plan 001 (provenance tightening) landing first but does not require it (it reuses whatever labels `unitDisplay.ts` produces).

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
| 011 Run solver accuracy gates in CI | TODO | Two PRs (sibling CI + open-cae step). Beware the `@opencae/core-cloud` filter trap. |
| 012 Broaden analytical solver benchmarks | TODO | Off-axis, ~604 Hz frequency gate, viz≤summary invariant, stress stabilization, dt diagnostic. |
| 013 Gmsh plate-with-hole Kt benchmark | TODO | First real-geometry gate (Kt_net ≈ 2.42 at d/W=0.25); pins gmsh in both Dockerfiles. |
| 014 Unit round-trip gate + strict units | TODO | Accuracy-plan Phase 2.3/2.4; reject unknown units instead of defaulting. |
| 015 Local-first browser solver parity | IN PROGRESS | Dynamic step-count preflight slice landed; fixtures, upstream hooks, persistence, and cloud-solve wind-down remain. |
| 016 WASM meshing and offline asset caching | TODO | Gmsh WASM smoke/licensing gate first; blocks full cloud infrastructure retirement. |
| 017 Sunset Core repo (monorepo consolidation) | DONE | Executed 2026-07-09 (Run 5): Core packages imported, sibling checkout/pin bootstrap removed, Core tests wired into CI. |
| 018 Mesh-failure repair probe + honest geometry errors | DONE | Executed 2026-07-10 (`fa2ae84`, with the Top-face heal cleanup in `f1aba34`). Re-test surfaced the true root error (Delaunay PLC segment/facet intersection) and two follow-up defects → plan 019. |
| 019 Frontal fallback before repair bail + model-keyed probe guard | DONE | Executed: thrown Delaunay quality-repair candidates continue to Frontal; project actions use generation/client identity rather than fragile object identity. |
| 020 One-click PDF simulation report | DONE | Executed: Results-panel PDF generation, persisted white-background captures, report data/layout, and unit/provenance honesty checks are shipped. |
| 021 OpenCAE Quick-Wins Rollout | IN PROGRESS | Five staged releases: result probes, unified palettes, principal stresses, projection/PNG export, and recent project handles. |
| 022 OpenCAE Medium-Feature Roadmap | IN PROGRESS | Flagship-first sequence. Increments 1-4 released; advanced loads and equivalent bolt preload are next. |

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

Run 3 (2026-07-02) — engineering claims verified against the code and rejected; do not re-audit without new evidence:

- "Production Rayleigh damping uses blind hardcoded defaults (α=10ζ, β=ζ·1e-4)" — refuted: the primary path calibrates modally (inverse-power ω₁, ω₂=4ω₁ anchoring, `rayleighFromFrequencies`); the cited constants are a fallback/override path.
- "Tet10 lumped mass is row-sum (/4 per node) and risks negative or zero mid-side masses" — refuted: explicit HRZ lumping (1/36 vertex, 4/27 edge, sums to 1) with a code comment citing exactly that pathology; plus a 1e-12 mass floor.
- Nine findings against `services/opencae-solver-service` (heuristic preview SDOF/stress path): ramp clamping, Rayleigh ignored, bounding-box mass floor, sign-blind stress scale, NaN guards, output-interval clamp, uncorrelated peaks, etc. — rejected as anti-leverage: the accuracy plan (C1/M5) and plan 001 direction is to gate/relabel/retire this honestly-provenanced demo path, not to refine its physics. If the maintainer instead decides to keep it long-term, these are real refinements to revisit.
- "Face-selection tolerances (1e-6 vs 1e-5 span) drop mid-side nodes" — numerically unsupported as written (claimed 1e-15 drift is inside the 1e-9..1e-6 bands); kept only as an UNCERTAIN backlog probe (empty-selection behavior).
- "Pressure loads use guessed projected areas" — cloud path integrates pressure over actual surface facets (`loads.ts`); the projected-area ×1000 shortcut is the local-preview block proxy only, consistent with its preview tier.
- "Dynamic reaction omits inertia/damping terms" — production computes per-frame reactions with a reactionBalance diagnostics trail and reports the end-state frame in the summary, which matches its ramp-to-static semantics; heuristic-path version rejected per above.
- Disconnected-mesh validation happening post-intake (422 at solve) — works correctly; ordering is a cost optimization at most.

## Not Audited (Run 3)

- The sibling's sparse assembly internals beyond the reviewed files; solver-wasm (1-line stub) and solver-webgpu (capability stub).
- Composite/nonlinear/thermal behavior — the product is linear elastostatics + linear transient dynamics only; no findings issued against absent capabilities.
- Numerical experiments (no solver executions were run — read-only audit); the UNCERTAIN items above say which experiment would resolve them.
- Physical test correlation: no lab data exists in either repo; all validation is analytical. For engineering signoff purposes OpenCAE results remain development-grade per the README's own scope statement — nothing in this audit constitutes professional engineering review or approval.

## Not Audited (Run 2)

- The sibling `../opencae-core` implementation (only its top-level intent docs were read for direction grounding).
- Live Cloudflare resources beyond the two public health endpoints; R2 contents; production logs.
- Browser-rendered UX / visual regression; dependency CVEs via online audit (`pnpm audit` not run — flagged "verify online" where relevant).
- Deep line-by-line coverage of `CadViewer.tsx` render internals and the Worker's every branch (hotspot-weighted standard-effort pass, four parallel auditors + manual vetting of every reported finding).
