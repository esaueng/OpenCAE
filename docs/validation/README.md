# Validation

OpenCAE runs production structural solves locally in the browser with OpenCAE Core (wasm meshing + local solve pipeline). The former OpenCAE Core Cloud backend was retired in July 2026 — see [docs/cloud-retirement.md](../cloud-retirement.md) — and its historical solve contract is frozen as a numeric regression oracle. Replays preserve current local solver provenance rather than impersonating the retired runner.

- **OpenCAE Core (local, in-browser)** is the production backend. Results must carry `opencae_core_fea`, `computed` result provenance, and `actual_volume_mesh` or `structured_block_core` mesh provenance.
- **OpenCAE Core Preview** is allowed only for explicit local development/demo flows. It uses structured display-bounds proxy meshes and must never be presented as production FEA.

Bracket and other complex geometry must fail Core Preview eligibility unless an actual Core volume mesh artifact is present; the production path meshes them in-browser before solving.

## Legacy Backend Results

Older project files can contain historical result provenance from retired backends: the removed CalculiX-backed container and the OpenCAE Core Cloud service retired in July 2026. OpenCAE may display those results as read-only history with their original labels, but it must not dispatch new work to those backends or reuse those artifacts as new production output. Re-run the study to solve locally in the browser before treating the result as current production FEA.

## Validate Locally

Run the full validation suite from the repository root:

```sh
pnpm test
```

Run only the frozen cloud-contract and Worker validation:

```sh
pnpm vitest run libs/opencae-solve-pipeline/src/goldenParity.test.ts apps/opencae-web/src/lib/coreCloudGolden.test.ts apps/opencae-web/worker/index.test.ts scripts/core-cloud-validation-docs.test.mjs
```

The golden parity suite replays every recorded OpenCAE Core Cloud solve fixture (`apps/opencae-web/src/testdata/core-cloud-golden`) through the browser pipeline and compares the retired production response numerically while requiring local solver and runner provenance. No local estimate fallback is allowed in these tests.

## Historical: Validate Deployed Cloud (retired 2026-07)

The deployed-cloud validation flow (cloud health readiness, run creation through the Worker, runner-version cross-checks) was retired with the cloud infrastructure; the retired routes now return HTTP 410 (see [docs/cloud-retirement.md](../cloud-retirement.md) for the exact route list). The deploy gates that remain are `pnpm verify:cloudflare-config` (asserts the retired bindings stay absent) and the Cloudflare dry run:

```sh
pnpm verify:cloudflare-config
pnpm deploy:cloudflare:dry-run
```

## OpenCAE Core Structural Load Support

The Core adapter preserves the study load's physical meaning and converts only at the model boundary:

- `force` is a total force in `N`, consistently distributed over its selected face. The UI arrow point is visual only.
- `pressure` and `surface_traction` are force densities converted to the Core coordinate system and integrated over the actual selected facets.
- `volume_force` is force per volume over an explicit body/element set. Tet4 uses equal weights and Tet10 uses positive HRZ lumping with exact resultant conservation. Ambiguous multi-body mapping is rejected.
- `gravity` payload mass in `kg` is converted to equivalent force with `massKg * 9.80665`.
- `remote_force` is an area-weighted minimum-norm distributed wrench. A scaled, rank-checked 6x6 solve must reproduce both total force and remote-point moment; it is not a rigid MPC coupling.
- `bolt_preload` is static-only. It validates two opposing faces and applies equal/opposite distributed tractions as an explicitly bonded-linear approximation without contact, slip, or fastener stiffness.

Surface traction, volume force, and remote force are supported in static and dynamic cases. Load diagnostics record integrated area/volume, resultant and moment, and balance errors where applicable.

Unsupported or incomplete studies must fail with clear Core diagnostics instead of publishing generated fallback results.

## OpenCAE Core Dynamic Support

Dynamic structural studies generate timed frames with Newmark average-acceleration integration in the local OpenCAE Core solve pipeline (and, historically, the retired Core Cloud flow). OpenCAE Core Preview dynamic results cannot be presented as validated FEA for complex geometry.

Supported dynamic load profiles:

- `ramp`: load scale is `0` at `startTime` and `1` at `endTime`.
- `step`: load scale is `1` for the whole step.
- `quasi_static`: currently shares step-load behavior in the Core CPU adapter.
- `sinusoidal`: a single sine cycle over the selected time range.

Choose `timeStep` small enough to resolve the fastest meaningful response change. Choose `outputInterval` for result and animation frame cadence; it is normalized to be greater than or equal to `timeStep`.

## Structural Load Cases And Combinations

Every structural load must belong to exactly one load case. Case ids must be unique, case load references must exist, and static combination factors must be finite and reference cases directly. Supports are structurally shared at the study level; Core also rejects any hand-built multi-step model whose case steps do not carry identical boundary-condition lists. Dynamic combinations and envelopes are not supported.

Static case batches must match separate direct solves. Combination regressions include negative factors and compare displacement, reactions, strain, all six stress components, recomputed von Mises, and recomputed principal measures. A scalar von Mises or principal field must never be combined directly. Envelope tests verify the pointwise stress maximum, complete governing displacement vector, and compact governing-variant indices.

Dynamic case validation requires one K/M assembly, shared damping calibration, independent zero initial conditions, ordered completion callbacks, separate persistence, cancellation cleanup, and no aggregate transient retention. All case, combination, envelope, playback, and probe keys include the active variant identity.

## Static Mesh-Convergence Studies

The automatic convergence ladder is available only for a selected static load case and always runs `coarse`, `medium`, then `fine`; `ultra` is intentionally manual. The displacement probe defaults to the primary load application point but remains explicit and editable. It must map to the nearest solver-surface triangle through barycentric interpolation within a scale-aware tolerance. Failure to map is a failed rung, not permission to sample an arbitrary node.

Each rung records actual generated node/element counts, total/free DOF, actual mesh size, the raw element peak von Mises stress, and the interpolated displacement magnitude. A generated mesh above the 100,000-DOF browser pipeline limit is marked skipped before a solve begins, and later rungs are still attempted so failures and caps remain visible.

"Apparent convergence" requires all three rungs to complete with strictly increasing actual DOF. The symmetric last-step change from medium to fine must be at most 5% for probe displacement and 10% for raw peak stress. Three successful increasing rungs outside either threshold are `unconverged`; missing, skipped, failed, or non-increasing rungs are `inconclusive`. This is a mesh-ladder indicator, not a proof of asymptotic convergence.

## OpenCAE Core Modal Support

Modal studies require positive density for every solved material, a generated mesh, and enough supports to make the constrained stiffness matrix nonsingular. They do not require or apply loads. The solver requests 1–10 modes (default 6) and uses deterministic block shift-invert subspace iteration with a block size of `min(modeCount + 2, freeDOFs)`.

A mode converges only when its unit-independent scaled residual

`||K phi - lambda M phi|| / max(||K phi||, |lambda| ||M phi||)`

is at most `1e-6`. The solver returns only converged modes and reports requested versus converged counts. Inner CG non-convergence or singular constrained systems must produce an explicit insufficient-supports error naming the Supports step. A raw CG error is not an acceptable user diagnostic.

## Benchmark Matrix

| Case | Model | Material | Load and support | Expected behavior |
| --- | --- | --- | --- | --- |
| Simple cantilever static | Connected Tet4 block | Linear elastic validation material | Fixed left face and transverse right-face force | Reaction force balances applied force, displacement/stress are finite and positive, safety factor is finite, fields are non-empty, and the solver surface mesh is connected. |
| Simple cantilever dynamic | Same connected Tet4 block | Linear elastic validation material with density | Fixed left face and ramp or step right-face force | Dynamic frame count matches the requested cadence, frames are unique, velocity/acceleration fields are present, fields are non-empty, and no frame is reused as a fake response. |
| Simple cantilever modal | Connected Tet10 beam | Linear elastic validation material with density | Fixed left face; no loads | First bending frequency is within 10% of Euler–Bernoulli theory, returned shapes are M-orthogonal, and every returned scaled residual is at most `1e-6`. |
| Pressure patch | Connected Tet4 block | Linear elastic validation material | Pressure on right face with explicit direction | Reaction force balances `pressure * surface area`; result provenance is computed production provenance. |
| Surface traction patch | Connected Tet4/Tet10 block | Linear elastic validation material | Vector traction on one surface | Tri3/Tri6 integration balances `traction * surface area` and conserves direction. |
| Volume force | Connected Tet4/Tet10 body | Linear elastic validation material | Vector force density on an explicit element set | Tet4/Tet10 nodal forces balance `force density * volume`; Tet10 HRZ weights remain positive. |
| Remote wrench | Nondegenerate selected surface | Linear elastic validation material | Total force and explicit remote point | Rank-checked distribution balances requested resultant and remote-point moment; degenerate selections fail. |
| Equivalent bolt preload | One connected static model with opposing faces | Linear elastic validation material | Axis and positive preload force | Equal/opposite tractions have zero net force and moment; invalid normals/centroids and dynamic use fail. |
| Payload mass | Connected Tet4 block | Linear elastic validation material with density | Body gravity equivalent of payload mass | Reaction force balances `mass * 9.80665`; no preview or local estimate fallback is used. |
| Bracket actual mesh static | Connected bracket Tet4 Core mesh artifact | Steel fixture material | Fixed base-mount surface and load on upright surface | Static result uses `actual_volume_mesh`, has connected surface output, finite stress/displacement/safety/reaction values, and non-empty fields. |
| Bracket actual mesh dynamic | Same connected bracket Tet4 Core mesh artifact | Steel fixture material with density | Dynamic ramp load on upright surface | MDOF dynamic result uses `actual_volume_mesh`, contains multiple unique frames, connected surface output, and production provenance. |
| Disconnected mesh rejection | Two disconnected Tet4 bodies without contact/tie metadata | Linear elastic validation material | Any nonzero load | The solve fails with disconnected-body diagnostics before solving. |
| Bracket without actual volume mesh | Bracket sample display model | Aluminum 6061 | Fixed mounting holes and top face load | OpenCAE Core Preview solving is rejected with an actual-volume-mesh diagnostic; the production path meshes the bracket in-browser first. |
| Bracket with actual volume mesh | Connected Tet4 Core mesh artifact | Aluminum 6061 | Mesh-bound supports and loads | Result may be labeled production FEA only with `actual_volume_mesh`, `computed`, and one connected component. |
| Material swap | Same cantilever block | Aluminum 6061 vs PETG or titanium | Same load/support | Dynamic response changes with density and damping. |
| Load scaling | Same block | Aluminum 6061 | Compare 1 N vs 2 N | Linear static response scales with load. |
| Dynamic cadence | Same block | Aluminum 6061 | `timeStep=0.005`, `outputInterval=0.01`, `endTime=0.025` | Frames appear at `0`, `0.01`, `0.02`, and final `0.025`. |
| Static signed combination | Connected Tet4 block | Linear elastic validation material | Two shared-support cases with positive and negative factors | Tensor/vector superposition matches a direct solve; von Mises and principal stresses are recomputed from the combined tensor. |
| Dynamic case isolation | Connected Tet4 block | Linear elastic validation material with density | Two cases sharing supports but carrying different loads | K/M is assembled once; both cases start from zero state, stream in order, and persist as separate transient records. |
| Static convergence ladder | Same static case remeshed coarse, medium, and fine | Same material and supports for every rung | Explicit surface-mappable displacement probe | Working mesh/results stay unchanged; actual DOF rises strictly; probe displacement and raw peak stress determine apparent, unconverged, or inconclusive status; over-limit meshes skip before solving. |

## Beam Theory Comparison

Use the simple cantilever cases as a coarse regression check against elementary beam theory, not as a certification-quality benchmark. For a rectangular cantilever with length `L`, modulus `E`, second moment of area `I`, and transverse tip load `F`:

- Tip displacement target: `delta = F * L^3 / (3 * E * I)`.
- Fixed-end bending stress target: `sigma = F * L * c / I`, where `c` is half the beam height.
- Reaction force target: the reported reaction magnitude must balance the applied load within solver tolerance.

The validation mesh is intentionally coarse Tet4 geometry, so displacement and stress checks use broad ranges. The strict checks are finite values, correct sign/direction behavior, reaction balance, non-empty fields, connected solver surface mesh, production provenance, and no preview/local fallback.

## Known Limitations

- The local validation suites use compact Tet4 and Tet10 fixtures; they are production-path regression suites, not mesh-convergence studies.
- Bracket validation uses a compact actual Core mesh fixture. Larger imported brackets still require a real Core volume mesh (generated in-browser) before solving.
- Modal validation reports partial convergence honestly. Passing the cantilever benchmark does not certify convergence or physical fidelity for arbitrary geometries.
- Result budgets compact visualization fields and frame payloads only. Engineering summary values such as max stress, max displacement, safety factor, and reaction force must remain full computed values.
- The local solver must fail with diagnostics when the model cannot be solved exactly. No local estimate fallback or CalculiX rerun path is permitted.

## Hard Failure Rules

Validation fails if any of these conditions are found:

- Complex geometry receives OpenCAE Core Preview, `structured_block_proxy`, or `computed_preview` provenance and is displayed as valid FEA.
- Complex geometry receives production FEA labels without `actual_volume_mesh`, `computed`, and a single connected component.
- An OpenCAE Core Preview dynamic result reports `reactionForce: 0` while nonzero loads exist without a reaction-force diagnostic.
- Static results omit stress, displacement, or safety-factor fields.
- Dynamic results omit velocity or acceleration frames.
- Modal results contain unconverged modes, displacement units, non-vector shapes, or omit requested/converged counts.
- A load is unassigned or repeated across cases, a combination references another combination, or a dynamic study contains combinations.
- Combination von Mises or principal stresses are formed by scalar superposition instead of recomputation from the combined stress tensor.
- Legacy or retired backend settings are exposed as selectable runtime options instead of being normalized to the local backend.
- New work is dispatched to any retired OpenCAE Core Cloud surface (guarded by `scripts/cloud-retirement-guard.test.mjs`).
