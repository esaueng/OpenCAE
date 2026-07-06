# CAE Output Quality & Accuracy Plan

Date: 2026-06-12

> **Historical note (2026-07):** this review predates the cloud retirement.
> `services/opencae-core-cloud` and the cloud solve path it analyzes were
> removed in July 2026 — production solves now run locally in the browser and
> the cloud contract survives as golden fixtures. See
> [docs/cloud-retirement.md](../cloud-retirement.md). Path references below
> are kept as written for the record.
Scope: full-repo review of every code path that produces, transforms, or displays
simulation numbers — `services/opencae-solver-service`, `services/opencae-post-service`,
`services/opencae-core-cloud`, `services/opencae-mesh-service`, `libs/opencae-core-adapter`,
`libs/opencae-units`, `libs/opencae-materials`, `libs/opencae-schema`, `apps/opencae-api`,
`apps/opencae-web`, plus the pinned sibling `OpenCAE-Core` solver packages.

Baseline at review time: `pnpm test` passes (679 tests / 61 files) once
`pnpm build:core` has run; CI gates typecheck, tests, runner-version, and
Cloudflare config.

## 1. Review summary

The production FEA path (`@opencae/solver-cpu` Tet4 linear elasticity consumed via
`services/opencae-core-cloud`) is a genuine finite-element implementation: the
B-matrix, isotropic D-matrix, Jacobian/volume checks (degenerate and inverted
element rejection), and von Mises recovery are textbook-correct, and the
core-cloud service fail-closes on preview provenance. The validation docs
(`docs/validation/README.md`) describe a sound methodology, including a benchmark
matrix and hard failure rules.

The accuracy risk is concentrated in three places:

1. **Several documented invariants are not enforced in code.** The hard failure
   rules exist as prose and as an unused schema, not as runtime gates.
2. **The local/demo result paths fabricate numbers**, and the provenance labels
   that distinguish them from real FEA are diluted by the time they reach the
   UI and reports.
3. **There is no quantitative accuracy gate** (analytical benchmarks with
   tolerances, mesh-convergence evidence, unit round-trip checks) in CI.

## 2. Findings

Severity reflects how directly the issue can put a wrong or misleading number in
front of a user making a design decision.

### Critical — fabricated or mislabeled numbers can be read as analysis output

- **C1. Heuristic "solver" invents stress fields.**
  `services/opencae-solver-service/src/index.ts:776-892` computes stress as
  gaussian distance falloff with hand-tuned coefficients on top of hardcoded
  per-face `baselineStress` lookup tables (`knownFaces`, lines 997-1030).
  Face areas for pressure loads are guessed from label text
  (`estimatedFaceArea`, lines 977-983: "pad" → 850, "base" → 1600 …) and
  pressure→force uses an undocumented `value * area * 0.001` (line 924).
  The provenance is honestly `local_estimate`/`generated`, but see C3/C4 for why
  that honesty does not survive to the user.

- **C2. UI fallback values are fabricated when no result exists.**
  `apps/opencae-web/src/resultFields.ts:799-804`: with no solver fields, face
  coloring falls back to embedded demo `stressValue`s, displacement is
  `stressValue / 770`, safety factor is `276 / stressValue` — magic constants
  calibrated to one demo bracket and Aluminum 6061's yield. A fresh bracket
  demo load also seeds a hardcoded summary (max stress 142 MPa, SF 1.8) in
  `apps/opencae-web/src/WorkspaceApp.tsx:70-89`.

- **C3. Provenance labels collapse "estimate" into "preview".**
  `apps/opencae-web/src/unitDisplay.ts:103-114` renders `local_estimate`
  (fabricated heuristic, C1/C2) with the same "OpenCAE Core Preview" label as
  genuine coarse Tet4 preview solves. A user cannot distinguish a real (if
  coarse) FEM solve from an invented number.

- **C4. Reports misrepresent their own content.**
  `services/opencae-post-service/src/index.ts:97-98` and `201-273`: the report's
  "Stress Field Preview" is a fixed, hardcoded beam drawing (same picture for
  every model and every result) captioned as showing "the expected high-gradient
  regions … from the solved result summary." The HTML/PDF report shows KPIs,
  a "Von Mises" row, and a pass/fail assessment but **never states the solver,
  mesh source, or provenance** — a `local_estimate` heuristic result produces a
  report indistinguishable from a real solve.

### High — documented gates not enforced; silent unit assumptions

- **H1. Runs are marked `complete` without provenance validation.**
  `apps/opencae-api/src/server.ts:458-464` persists whatever
  `trySolveOpenCaeCoreStudy` returns and marks the run complete.
  `CoreCloudResultProvenanceSchema` (`libs/opencae-schema/src/index.ts:119-149`)
  encodes the production rules but is referenced only by its own unit tests —
  it is never applied at persist, import, or display time. Imported project
  results (`server.ts` import flow) are likewise accepted without a provenance
  audit.

- **H2. Local "Core" solves run on a tiny structured-block proxy of the
  geometry.** `libs/opencae-core-adapter/src/index.ts`:
  `meshCellsForPreset` tops out at 6×5×4 cells even on "ultra", and
  `maxDofsForMeshPreset` caps the solve at a few hundred DOFs. The result is a
  real Tet4 solve, but of a block with the model's bounding dimensions — not the
  model — yet it flows into a `complete` run with stress/displacement/safety
  numbers and a report (H1, C4).

- **H3. Unit handling is assumption-based at every boundary.**
  - STL import hardcodes `units: "mm"` (`libs/opencae-units/src/index.ts:30`);
    a meters- or inches-authored STL silently mis-scales dimensions, volume,
    payload mass, and every downstream load.
  - `loadForceNewtons` (`services/opencae-solver-service/src/studyInputs.ts:6-17`)
    returns `parameters.value` raw for non-gravity loads with no unit field
    check; `primaryBeamLoad` (`beamDemoSolver.ts:453-455`) falls back to
    `study.loads[0]`, so a pressure load's Pa/kPa value can be consumed as
    newtons by the beam demo path.
  - `normalizeCoreCloudResultForUi` (`services/opencae-core-cloud/src/index.ts:241-284`)
    rewrites provenance units to `mm-N-s-MPa` unconditionally and recognizes
    only two unit strings, defaulting everything else to Pa/m silently.

- **H4. Meshing is a stub with constant statistics.**
  `services/opencae-mesh-service/src/index.ts` returns the same hardcoded
  node/element counts per preset for any geometry; no mesh is generated, and no
  quality metric (aspect ratio, skewness) exists anywhere. "Mesh: complete" is
  a UI state, not an artifact.

### Medium — accuracy and robustness gaps inside otherwise-correct paths

- **M1. No quantitative accuracy gate in CI.** Tests assert contract shape
  (finite, positive, non-empty, provenance strings) but not closeness to
  analytical references with tolerances. The beam-theory comparison in
  `docs/validation/README.md:91-99` is documented as using "broad ranges" only.

- **M2. No mesh-convergence evidence.** Tet4 elements are overly stiff
  (displacement under-prediction, stress under-resolution at concentrations);
  with the DOF caps in H2 this is structural, but nothing measures or reports
  discretization error, and `assessResultFailure`
  (`libs/opencae-schema/src/index.ts:381-413`) issues "pass / unlikely to
  yield" verdicts on any finite safety factor regardless of provenance or mesh
  adequacy.

- **M3. Surface-field alignment checks count, not correspondence.**
  `services/opencae-core-cloud/src/index.ts:327-348` validates node count and
  mesh id only; a permuted node ordering would render stress at wrong locations
  undetected. The web viewer's coordinate-space diagnostic
  (`apps/opencae-web/src/resultFields.ts:714-729`) only warns at >25× extent
  ratio, so an mm/m (1000×→ but 10×-25× per-axis) mismatch can pass silently.

- **M4. Beam-demo specifics.** The Euler-Bernoulli formulas in
  `beamDemoSolver.ts` are correct (verified: deflection for intermediate load
  station, fixed-end moment, σ = Mc/I), but: study detection is text matching
  on selection/project names (`isBeamDemoStudy`, lines 101-114) and can
  misclassify; the centerline stress sample uses an invented `0.4` fiber factor
  (line 432-434); slenderness is never checked, so beam theory would be applied
  to a stubby model that matches the face-id pattern.

- **M5. Demo dynamic results carry a "complete run" shape.**
  `apps/opencae-web/src/localProjectFactory.ts:171-186` seeds
  `opencae-core-preview-sdof` runs; dynamic SDOF scaling of a static heuristic
  field (`solver-service/src/index.ts:293-373`) is dimensionally self-consistent
  but physically arbitrary (stiffness back-derived from heuristic displacement).

## 3. Plan

Ordered so each phase is independently shippable and the highest-risk
misrepresentations are removed first. "Gate" means a check that fails the build
or the request, not a console warning.

### Phase 1 — Enforce truthfulness (fail closed)

1. **Wire `CoreCloudResultProvenanceSchema` into the pipeline.** Apply it (or a
   tiered variant) wherever a result is persisted or marked complete:
   `apps/opencae-api/src/server.ts` run completion, project import, and the
   worker result path. A run whose provenance is not production-grade must be
   stored with an explicit non-production status (e.g. `complete_preview`,
   `complete_estimate`), never bare `complete`. Add API tests that a
   `local_estimate` result cannot reach `complete`.
2. **Split the result-status taxonomy end-to-end.** Carry the provenance tier
   (production FEA / core preview / local estimate / analytical benchmark /
   imported legacy) as a first-class enum on runs and summaries, and make the
   web app and API treat it as load-bearing, not a display hint.
3. **Fix the UI labels.** `unitDisplay.ts`: `local_estimate` must label as
   "Estimate (not FEA)" or equivalent — never "OpenCAE Core Preview". Preview
   labels must state the proxy-mesh fact ("coarse block proxy of model bounds").
4. **Make reports honest.** In `opencae-post-service`: include solver,
   provenance tier, mesh source, units, and run id in every report; replace the
   hardcoded "Stress Field Preview" drawing with either a real rendering of the
   result samples or a clearly-labeled schematic ("illustration — not model
   geometry"); print a prominent banner on non-production results. Block PDF
   export of `local_estimate` results, or watermark them "NOT ANALYSIS".
5. **Remove fabricated UI fallbacks.** Delete `fallbackValue` magic constants
   (`resultFields.ts:799-804`) and the seeded bracket summary, or gate them
   behind an unmistakable "sample data" mode that cannot coexist with a real
   study. Face `stressValue` should be renamed (e.g. `demoColorWeight`) so it
   can never be mistaken for a result.

### Phase 2 — Unit integrity

1. **Single source of truth for units.** Define a typed unit system on every
   load, material, dimension, and result field in `@opencae/schema`; remove
   bare `parameters.value` reads. `loadForceNewtons` must require an explicit
   unit and reject unknown ones; the beam-demo `primaryBeamLoad` fallback to
   `loads[0]` must filter to force/gravity types.
2. **STL/OBJ unit handling.** On upload, detect implausible scales (bounding box
   < 1 or > 10⁴ mm) and require the user to confirm units; store the confirmed
   unit on the display model instead of hardcoding `"mm"`.
3. **Strict unit normalization in core-cloud.** `normalizeCoreCloudResultForUi`
   must reject (422) any units string it does not recognize instead of
   defaulting to Pa/m, and must record the raw→display conversion in the result
   artifacts. Add a test feeding mislabeled units and asserting rejection.
4. **Round-trip unit tests.** A CI test that pushes a known model through
   solver → normalization → UI formatting and asserts the displayed magnitude
   equals the analytical value in display units (catches any silent ×1000/×10⁶).

### Phase 3 — Quantitative accuracy gates in CI

1. **Analytical benchmark suite with tolerances.** Implement the documented
   benchmark matrix as executable tests against `@opencae/solver-cpu` with
   numeric tolerances, not just finiteness:
   - Cantilever tip deflection `FL³/3EI` and fixed-end stress `FLc/I` at a mesh
     density where Tet4 should be within a stated band (document the band, e.g.
     ±15% displacement at N elements, and tighten as elements improve).
   - Patch test (constant-strain field reproduced exactly — Tet4 must pass to
     machine precision; this catches B-matrix/assembly regressions).
   - Reaction equilibrium: Σ reactions = Σ applied loads to 1e-9 relative.
   - Material/load linearity: 2× load ⇒ 2× displacement and stress.
   - Dynamic: SDOF/MDOF free-vibration frequency vs analytical `√(k/m)/2π`
     within tolerance; Newmark unconditional-stability sanity at large dt.
2. **Mesh-convergence regression.** For one benchmark geometry, solve at 3+
   refinements, assert monotone convergence and record the Richardson-
   extrapolated error; fail CI if the discretization error at the default
   preset exceeds a documented threshold.
3. **Beam-demo cross-check as a test.** The existing `auditBeamDemoInputs`
   10%-deviation console warning becomes a hard test assertion; add a
   slenderness guard (`L/h ≥ 10`) before the beam path is selected, falling
   back to a refusal diagnostic rather than the heuristic solver.
4. **Field/mesh correspondence test.** Add a permuted-node-order fixture and
   assert the core-cloud alignment check (extended to verify a checksum or
   node-id mapping, not just count — M3) rejects it.

### Phase 4 — Real meshing and solver capability (removes the need for fakes)

1. **Actual mesh statistics.** Replace `MockMeshService` constants with real
   counts from the generated/imported mesh, plus element-quality metrics
   (min Jacobian, aspect ratio); surface warnings into study diagnostics and
   block solves on degenerate meshes (extend `hasActualCoreVolumeMesh` beyond
   connected-component count: material coverage, node-set validity, inverted
   elements).
2. **Raise local solve fidelity honestly.** Either raise the DOF caps in
   `maxDofsForMeshPreset` so presets mean something, or surface "solved on an
   N-element block proxy" in the result summary and report. Long term, route
   uploaded geometry through real volume meshing to Core Cloud and retire the
   heuristic surface solver (C1) entirely — demo visuals can be served by an
   explicit, non-result "appearance preview" mode.
3. **Tet10 or stress-recovery improvement** in OpenCAE-Core (sibling repo) to
   address Tet4 stiffness at stress concentrations; gate with the Phase 3
   convergence suite.

### Phase 5 — Assessment and reporting rigor

1. **Provenance-aware failure assessment.** `assessResultFailure` must require a
   production or preview tier to issue pass/fail; estimates get
   `status: "unknown"` with an explanatory message. Include the mesh-adequacy
   diagnostic (Phase 3.2) in the assessment text.
2. **Uncertainty in summaries.** Report safety factor with the source yield
   strength and effective-material derivation (print-settings knockdowns from
   `effectiveMaterialProperties` are heuristics — cite them in diagnostics so a
   user knows a 0.35 layer-adhesion factor was applied).
3. **Documentation parity check in CI.** Extend
   `scripts/core-cloud-validation-docs.test.mjs` to assert that every "hard
   failure rule" in `docs/validation/README.md` has a corresponding executable
   test (rule-id cross-reference), so docs and gates cannot drift.

## 4. Acceptance criteria

- No code path can persist or display a `generated`/`local_estimate` value with
  status `complete` or label "Preview"/"FEA".
- Every displayed number's units are derived from a typed conversion with a
  round-trip test; no hardcoded unit strings at boundaries.
- CI fails if: patch test fails; cantilever benchmarks drift beyond documented
  tolerance; equilibrium residual exceeds 1e-9; convergence regression breaks;
  a documented hard-failure rule lacks a matching test.
- Reports always show solver, provenance tier, mesh source, and units; the
  result image is real or labeled as schematic.
- Magic constants (770, 276, 0.4 fiber factor, gaussian coefficients) are
  removed or moved behind clearly-named demo-only modules with no path into
  result summaries.
