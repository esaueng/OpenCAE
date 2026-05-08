# Validation

OpenCAE uses OpenCAE Core for browser-local structural solves, with two deliberately separate result classes:

- **OpenCAE Core preview** is allowed only for simple block or beam-like geometry. It uses structured display-bounds proxy meshes and must carry `local_estimate`, `structured_block_proxy`, and `computed_preview` provenance.
- **OpenCAE Core FEA** is reserved for actual connected volume-mesh solves. Complex geometry must carry `opencae_core_fea`, `actual_volume_mesh`, and `computed` provenance, with mesh connectivity reporting exactly one connected component.

Bracket and other complex geometry must fail browser Core preview eligibility unless an actual Core volume mesh artifact is present. Use Cloud FEA or generate an actual Core volume mesh for those cases.

Run the validation suite with:

```sh
pnpm test
```

## OpenCAE Core Static Load Support

The Core CPU solver accepts study loads from the UI and adapts them to a small Tet4 Core model:

- `force`: total force in `N` is applied as a nodal force.
- `pressure`: `kPa` is converted to an equivalent force from the display-model projected area.
- `gravity`: payload mass in `kg` is converted to equivalent force with `massKg * 9.80665`.

Unsupported or incomplete studies must fail with clear Core diagnostics instead of publishing generated fallback results.

## OpenCAE Core Dynamic Support

Dynamic structural studies generate timed frames with Newmark average-acceleration integration. Dynamic result bundles include `stress`, `displacement`, `velocity`, `acceleration`, and `safety_factor` fields per frame. Preview dynamic results must be labeled `opencae-core-preview-sdof` and cannot be presented as validated FEA for complex geometry.

Supported dynamic load profiles:

- `ramp`: load scale is `0` at `startTime` and `1` at `endTime`.
- `step`: load scale is `1` for the whole step.
- `quasi_static`: currently shares step-load behavior in the Core CPU adapter.
- `sinusoidal`: a single sine cycle over the selected time range.

Choose `timeStep` small enough to resolve the fastest meaningful response change. Choose `outputInterval` for result and animation frame cadence; it is normalized to be greater than or equal to `timeStep`.

## Benchmark Matrix

| Case | Model | Material | Load and support | Expected behavior |
| --- | --- | --- | --- | --- |
| Cantilever bending block | `L=100 mm`, `W=30 mm`, `H=10 mm` | Aluminum 6061 | Fixed support and total `1 N` in `-Z` | Core result is finite, has positive stress/displacement, and reports Core provenance. |
| Bracket without actual volume mesh | Bracket sample display model | Aluminum 6061 | Fixed mounting holes and top face load | OpenCAE Core preview is rejected with an actual-volume-mesh or Cloud FEA diagnostic. |
| Bracket with actual volume mesh | Connected Tet4 Core mesh artifact | Aluminum 6061 | Mesh-bound supports and loads | Result may be labeled OpenCAE Core FEA only with `actual_volume_mesh`, `computed`, and one connected component. |
| Material swap | Same cantilever block | Aluminum 6061 vs PETG or titanium | Same load/support | Dynamic response changes with density and damping. |
| Load scaling | Same block | Aluminum 6061 | Compare 1 N vs 2 N | Linear static response scales with load. |
| Dynamic cadence | Same block | Aluminum 6061 | `timeStep=0.005`, `outputInterval=0.01`, `endTime=0.025` | Frames appear at `0`, `0.01`, `0.02`, and final `0.025`. |

## Hard Failure Rules

Validation fails if any of these conditions are found:

- Complex geometry receives `opencae-core-preview-sdof`, `structured_block_proxy`, or `computed_preview` provenance and is displayed as valid FEA.
- Complex geometry receives OpenCAE Core FEA labels without `actual_volume_mesh`, `computed`, and a single connected component.
- A preview dynamic result reports `reactionForce: 0` while nonzero loads exist without a reaction-force diagnostic.
- Static results omit stress, displacement, or safety-factor fields.
- Dynamic results omit velocity or acceleration frames.
- Legacy backend settings are exposed as selectable runtime options instead of being normalized to OpenCAE Core.
