# Validation

OpenCAE uses OpenCAE Core as its only solver runtime. Static and dynamic structural results must carry `opencae_core_fea` provenance with `opencae_core_tet4` mesh provenance and `computed` result provenance.

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

Dynamic structural studies use the Core static response as the linear response basis, then generate timed frames with Newmark average-acceleration integration. Dynamic result bundles include `stress`, `displacement`, `velocity`, `acceleration`, and `safety_factor` fields per frame.

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
| Material swap | Same cantilever block | Aluminum 6061 vs PETG or titanium | Same load/support | Dynamic response changes with density and damping. |
| Load scaling | Same block | Aluminum 6061 | Compare 1 N vs 2 N | Linear static response scales with load. |
| Dynamic cadence | Same block | Aluminum 6061 | `timeStep=0.005`, `outputInterval=0.01`, `endTime=0.025` | Frames appear at `0`, `0.01`, `0.02`, and final `0.025`. |

## Hard Failure Rules

Validation fails if any of these conditions are found:

- A newly generated result contains non-Core solver provenance.
- A newly generated result uses generated fallback, local estimate, or parsed external-solver provenance.
- Static results omit stress, displacement, or safety-factor fields.
- Dynamic results omit velocity or acceleration frames.
- Legacy backend settings are exposed as selectable runtime options instead of being normalized to OpenCAE Core.
