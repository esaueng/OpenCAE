# Validation

OpenCAE runs production structural solves locally in the browser with OpenCAE Core (wasm meshing + local solve pipeline). The former OpenCAE Core Cloud backend was retired in July 2026 — see [docs/cloud-retirement.md](../cloud-retirement.md) — and its exact solve contract is frozen as golden fixtures that the local pipeline must keep reproducing.

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

The golden parity suite replays every recorded OpenCAE Core Cloud solve fixture (`apps/opencae-web/src/testdata/core-cloud-golden`) through the browser pipeline and requires the retired production responses to be reproduced (1e-12 relative numeric tolerance). No local estimate fallback is allowed in these tests.

## Historical: Validate Deployed Cloud (retired 2026-07)

The deployed-cloud validation flow (cloud health readiness, run creation through the Worker, runner-version cross-checks) was retired with the cloud infrastructure; the retired routes now return HTTP 410 (see [docs/cloud-retirement.md](../cloud-retirement.md) for the exact route list). The deploy gates that remain are `pnpm verify:cloudflare-config` (asserts the retired bindings stay absent) and `pnpm verify:core-ref` (asserts the pinned OpenCAE Core solver ref is reachable):

```sh
pnpm verify:cloudflare-config
pnpm verify:core-ref
pnpm deploy:cloudflare:dry-run
```

## OpenCAE Core Static Load Support

The Core CPU solver accepts study loads from the UI and adapts them to a small Tet4 Core model:

- `force`: total force in `N` is applied as a nodal force.
- `pressure`: `kPa` is converted to an equivalent force from the display-model projected area.
- `gravity`: payload mass in `kg` is converted to equivalent force with `massKg * 9.80665`.

Unsupported or incomplete studies must fail with clear Core diagnostics instead of publishing generated fallback results.

## OpenCAE Core Dynamic Support

Dynamic structural studies generate timed frames with Newmark average-acceleration integration in the local OpenCAE Core solve pipeline (and, historically, the retired Core Cloud flow). OpenCAE Core Preview dynamic results cannot be presented as validated FEA for complex geometry.

Supported dynamic load profiles:

- `ramp`: load scale is `0` at `startTime` and `1` at `endTime`.
- `step`: load scale is `1` for the whole step.
- `quasi_static`: currently shares step-load behavior in the Core CPU adapter.
- `sinusoidal`: a single sine cycle over the selected time range.

Choose `timeStep` small enough to resolve the fastest meaningful response change. Choose `outputInterval` for result and animation frame cadence; it is normalized to be greater than or equal to `timeStep`.

## Benchmark Matrix

| Case | Model | Material | Load and support | Expected behavior |
| --- | --- | --- | --- | --- |
| Simple cantilever static | Connected Tet4 block | Linear elastic validation material | Fixed left face and transverse right-face force | Reaction force balances applied force, displacement/stress are finite and positive, safety factor is finite, fields are non-empty, and the solver surface mesh is connected. |
| Simple cantilever dynamic | Same connected Tet4 block | Linear elastic validation material with density | Fixed left face and ramp or step right-face force | Dynamic frame count matches the requested cadence, frames are unique, velocity/acceleration fields are present, fields are non-empty, and no frame is reused as a fake response. |
| Pressure patch | Connected Tet4 block | Linear elastic validation material | Pressure on right face with explicit direction | Reaction force balances `pressure * surface area`; result provenance is computed production provenance. |
| Payload mass | Connected Tet4 block | Linear elastic validation material with density | Body gravity equivalent of payload mass | Reaction force balances `mass * 9.80665`; no preview or local estimate fallback is used. |
| Bracket actual mesh static | Connected bracket Tet4 Core mesh artifact | Steel fixture material | Fixed base-mount surface and load on upright surface | Static result uses `actual_volume_mesh`, has connected surface output, finite stress/displacement/safety/reaction values, and non-empty fields. |
| Bracket actual mesh dynamic | Same connected bracket Tet4 Core mesh artifact | Steel fixture material with density | Dynamic ramp load on upright surface | MDOF dynamic result uses `actual_volume_mesh`, contains multiple unique frames, connected surface output, and production provenance. |
| Disconnected mesh rejection | Two disconnected Tet4 bodies without contact/tie metadata | Linear elastic validation material | Any nonzero load | The solve fails with disconnected-body diagnostics before solving. |
| Bracket without actual volume mesh | Bracket sample display model | Aluminum 6061 | Fixed mounting holes and top face load | OpenCAE Core Preview solving is rejected with an actual-volume-mesh diagnostic; the production path meshes the bracket in-browser first. |
| Bracket with actual volume mesh | Connected Tet4 Core mesh artifact | Aluminum 6061 | Mesh-bound supports and loads | Result may be labeled production FEA only with `actual_volume_mesh`, `computed`, and one connected component. |
| Material swap | Same cantilever block | Aluminum 6061 vs PETG or titanium | Same load/support | Dynamic response changes with density and damping. |
| Load scaling | Same block | Aluminum 6061 | Compare 1 N vs 2 N | Linear static response scales with load. |
| Dynamic cadence | Same block | Aluminum 6061 | `timeStep=0.005`, `outputInterval=0.01`, `endTime=0.025` | Frames appear at `0`, `0.01`, `0.02`, and final `0.025`. |

## Beam Theory Comparison

Use the simple cantilever cases as a coarse regression check against elementary beam theory, not as a certification-quality benchmark. For a rectangular cantilever with length `L`, modulus `E`, second moment of area `I`, and transverse tip load `F`:

- Tip displacement target: `delta = F * L^3 / (3 * E * I)`.
- Fixed-end bending stress target: `sigma = F * L * c / I`, where `c` is half the beam height.
- Reaction force target: the reported reaction magnitude must balance the applied load within solver tolerance.

The validation mesh is intentionally coarse Tet4 geometry, so displacement and stress checks use broad ranges. The strict checks are finite values, correct sign/direction behavior, reaction balance, non-empty fields, connected solver surface mesh, production provenance, and no preview/local fallback.

## Known Limitations

- The local validation suites use small Tet4 fixtures; they are production-path regression suites, not mesh-convergence studies.
- Bracket validation uses a compact actual Core mesh fixture. Larger imported brackets still require a real Core volume mesh (generated in-browser) before solving.
- Dynamic validation checks frame cadence and unique response frames; it does not claim modal convergence for arbitrary geometries.
- Result budgets compact visualization fields and frame payloads only. Engineering summary values such as max stress, max displacement, safety factor, and reaction force must remain full computed values.
- The local solver must fail with diagnostics when the model cannot be solved exactly. No local estimate fallback or CalculiX rerun path is permitted.

## Hard Failure Rules

Validation fails if any of these conditions are found:

- Complex geometry receives OpenCAE Core Preview, `structured_block_proxy`, or `computed_preview` provenance and is displayed as valid FEA.
- Complex geometry receives production FEA labels without `actual_volume_mesh`, `computed`, and a single connected component.
- An OpenCAE Core Preview dynamic result reports `reactionForce: 0` while nonzero loads exist without a reaction-force diagnostic.
- Static results omit stress, displacement, or safety-factor fields.
- Dynamic results omit velocity or acceleration frames.
- Legacy or retired backend settings are exposed as selectable runtime options instead of being normalized to the local backend.
- New work is dispatched to the retired OpenCAE Core Cloud surface (guarded by `scripts/cloud-retirement-guard.test.mjs`).
