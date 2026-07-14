# 021 — OpenCAE Quick-Wins Rollout

## Summary

Deliver five independently releasable stages over roughly **9–11 engineer-days**:

| Stage | Deliverable | Estimate |
| - | - | -: |
| 1 | Result identity foundation and click-anywhere probes | 1.5–2 days |
| 2 | Unified color pipeline and legend controls | 1.5–2 days |
| 3 | σ₁, σ₃, and maximum-shear contours | 2–2.5 days |
| 4 | Orthographic projection and clean PNG export | 1.5–2 days |
| 5 | Recent-project handles and start-screen list | 1.5–2 days |

Each stage ends with focused tests, `pnpm typecheck`, `pnpm build`, a full `pnpm test` run, an imperative commit, and a push to `main`. The typecheck/test baseline was verified green at `861636f` on 2026-07-14.

Palette unification precedes principal stresses because the principal fields need a diverging ramp. Building it into the old dual color pipeline and migrating one stage later would duplicate work.

## Contracts and compatibility

- Add optional `ResultField.component` / `StressComponent` values: `von_mises`, `principal_max`, `principal_min`, and `max_shear`. A missing component remains synonymous with von Mises.
- Keep `ResultMode` as the coarse field type; add `stressComponent` as separate UI state defaulting to von Mises.
- Include the component in transient range keys, packed-playback descriptors, field-series keys, selectors, and cache signatures.
- Add autosaved UI types for projection and per-field color-scale settings. Old UI snapshots must load cleanly. Do not bump the project-file version.
- Keep `ResultSummary.maxStress`, safety-factor derivation, Reverse Check, report captions, and automatic report peak selection strictly based on von Mises, including the existing unaveraged element-peak policy.

## Stage 1 — Result selection and spatial probes

- Centralize selection of the active scalar field by result type, stress component, surface-mesh alignment, and frame.
- Add pick handlers to solver-surface and sampled fallback result meshes.
  - Aligned nodal surfaces retain triangle indices and barycentric weights and interpolate nodal scalars exactly.
  - Procedural/sample-backed results retain the result-space point and use `interpolateScalarFromSamples`.
- Pins retain spatial anchors and recompute position/value when field, component, unit system, deformation, or dynamic frame changes. Clear pins when the run, project, or surface topology changes.
- Disable placement during active playback; existing pins update at viewer cadence.
- Show engineering values independent of legend clamping, derived from unrounded canonical-unit data.
- Add a Results-panel list with per-pin removal and Clear All; cap at 20 and report the cap.
- Keep `shouldShowResultMarkers` returning `false`; user-created pins are independent.

## Stage 2 — Unified palette and legend controls

- Replace `resultPalette`, `colorForResult`/`gradient`, and hardcoded CSS gradients with one dependency-free scale module shared by all renderers, probes, and the HTML legend.
- Update `.analysis-legend` and `.legend-scale` assertions in `appCss.test.ts` to pin the module-driven contract. Preserve layout/handle pins.
- Preserve sequential ramps and reversed safety-factor direction. Add a blue–neutral–red diverging ramp whose neutral stop is physical zero without forcing a symmetric numeric range.
- Add per-field Auto/Manual ranges. Manual bounds must be finite and separated by a scale-relative epsilon. Clamp colors only; never numerical results, probes, or summaries. Reset to the current run-wide range.
- Add Continuous / 8-bands rendering, with the renderer and legend using the same quantization/stops.
- Store overrides in canonical field units, convert displayed values on unit changes, and autosave by run plus semantic field identity. New runs start in Auto.

## Stage 3 — Principal and maximum-shear stresses

- Recover symmetric tensors in `[σxx, σyy, σzz, τxy, τyz, τxz]` order.
- Implement a scaled-tolerance bounded Jacobi eigensolver for symmetric 3×3 tensors. Avoid exact floating-point comparisons and sort descending. Define σ₁ as largest algebraic, σ₃ as smallest, and τmax = (σ₁ − σ₃) / 2.
- Recover volume-weighted nodal stress tensors for Tet4 and Tet10, static and every dynamic frame, six components per node.
- Derive σ₁/σ₃/τmax lazily in the Stage 1 selector and memoize per frame/component instead of emitting three extra nodal series.
- Derive from raw canonical tensors; convert only at display. Keep σ₁/σ₃ signed and τmax nonnegative; signed fields use the diverging ramp.
- Mark existing stress fields explicitly as von Mises and add a stress-measure selector that hides measures when tensors are absent.
- Keep safety factor, summaries, diagnostics, and reports on von Mises only.

## Stage 4 — Orthographic projection and image export

Ship projection and export as separate commits.

### Projection toggle

- Add a Perspective / Orthographic toggle beside camera presets, defaulting to perspective and restored through UI autosave.
- Preserve direction, target, up, and apparent model size when switching.
- Make fit/reset, presets, resize, OrbitControls zoom, custom shift-pan, and report capture frustum-aware. Orthographic fits update frustum/zoom and capture restores all camera state.

### Export PNG

- Add Export PNG to Results. Prepare the save target during the click gesture, then serialize capture through `report/captureResultViews.ts`.
- Export current field/component/frame and camera direction as a tightly fitted white-background PNG.
- Include WebGL annotations and pinned probes; exclude HTML legend, application UI, and view gizmo.
- Name files from project, field/component, and frame/time metadata. Do not alter persisted report captures.
- Route report capture and manual export through one queue so overlapping requests cannot race.

## Stage 5 — Recent projects

- Add an isolated IndexedDB store for up to eight recent file handles with stable ID, filename, project name, and last-opened timestamp.
- Use `showOpenFilePicker` when supported and retain handles. Expose successful `showSaveFilePicker` handles from the save adapter so saved projects enter recents.
- Deduplicate with `isSameEntry` when available, sort newest first, and prune after eight.
- Add Recent Projects to the start screen with Open, Remove, and Clear List.
- Request read permission only from a user click. Surface denied permission, missing files, invalid contents, blocked IndexedDB, and stale handles inline without affecting the workspace/autosave.
- Preserve file-input/download fallback and hide handle recents when File System Access or IndexedDB is unavailable. Saving continues to show a picker.

## Verification and acceptance

- Solver: uniaxial, hydrostatic, pure shear, rotated, repeated-eigenvalue, and near-degenerate tensors; Tet4/Tet10 recovery; static/dynamic lengths, units, alignment; unchanged von Mises summaries.
- Contract/playback: legacy von Mises default, lazy derivation across selection/interpolation/packed playback, memoization across scrubbing, signed ranges not zero-forced, and transient payload size near baseline.
- Viewer: barycentric and sampled probes, live frame/component updates, deformed anchors, run/project clearing, cap, and raw values unaffected by clamps.
- Palette: renderer/legend parity, clamping, band boundaries, safety reversal, diverging zero, and CSS pins.
- Camera/export: apparent-scale preservation, orthographic fit/pan/resize, camera restoration, capture queue, cancellation, PNG conversion, and filenames.
- Recents: persistence, ordering, deduplication, pruning, removal, denied permission, stale handles, and fallback.
- Manual Chromium QA on static, dynamic, and uploaded STEP results, including an ultra dynamic memory check.
- Before each stage commit: focused Vitest, `pnpm typecheck`, `pnpm build`, and `pnpm test`; push each stage to `main`.
- Stage only owned files. Never blanket-add or revert `libs/opencae-core-adapter`, which may contain live WIP.
