# 023 — Production E2E QA Fixes

## Status

**READY** — grounded in a full production-browser pass against `https://cae.esau.app` on 2026-07-17.

## Goal

Fix the correctness, workflow, accessibility, and feedback defects found during production end-to-end testing without changing solver equations, numerical outputs, units, defaults, public APIs, or the project-file format. The highest priority is eliminating stale result visualization: the viewer must never show contours or legends from a different project, study type, or run.

Estimated implementation effort: **3.5–5 engineer-days**, delivered as five independently reviewable commits.

## Production findings and disposition

| Priority | Finding | User risk | Primary code seams | Disposition |
| - | - | - | - | - |
| P1 | Switching to an unsolved analysis can leave the previous analysis legend/contour visible while the Results panel says no results exist. | An engineer can read stale temperature or stress data as current. | `WorkspaceApp.tsx`, `CadViewer.tsx`, result selection/playback caches | Fix first; add an explicit result-display eligibility contract. |
| P1 | Analysis-type buttons immediately reload the sample project and bypass the adjacent two-click confirmation. | Unintentional loss of the current sample setup. | `RightPanel.tsx`, `WorkspaceApp.tsx` | Make model and analysis selection draft-only; one confirmed action performs the reload. |
| P2 | The bracket's default mesh-convergence probe does not map to the generated solver surface at any rung. | All three solves succeed but the study is reported inconclusive for an avoidable mapping failure. | `meshConvergence.ts`, Mesh panel in `RightPanel.tsx` | Resolve system-generated probes against the prepared solver surface while retaining strict behavior for explicit probes. |
| P2 | Load editing exposes duplicate accessible names; result and viewer toggles omit pressed state. | Screen-reader and voice-control users cannot reliably identify or query controls. | `RightPanel.tsx`, `CadViewer.tsx` | Remove duplicate edit/add controls and expose toggle state. |
| P2 | Thermal Run displays `sparse_static` although the established thermal method name is `sparse_steady_thermal`. | Misleading run provenance. | `RightPanel.tsx`, `unitDisplay.ts` | Reuse the existing canonical method label. |
| P3 | Copy Logs succeeds without visual or assistive confirmation. | Users retry an action that already worked and receive no failure signal. | `BottomPanel.tsx` | Add transient success/failure feedback and a live announcement. |

Native save-picker automation and STEP file-chooser automation were tool limitations during the QA pass, not confirmed product defects. They are test-harness follow-ups, not production behavior changes in this plan.

## Contracts and compatibility

- A result visualization is eligible only when the active project/study has a current, compatible result summary and at least one selectable field for that result identity.
- Project/study/run identity changes synchronously invalidate active result selection, transient playback, captured-result selection, probes, legend state, and result-only viewer mode before any asynchronous load or solve can complete.
- An empty Results step may explain that a run is required, but it must render the model without result colors or a result legend.
- Sample cards and analysis buttons update a local draft only. Reload occurs through one explicit confirmation path. Double-click/open shortcuts must use the same destructive-action contract rather than bypass it.
- A system-generated convergence probe may be projected onto the actual solver surface with a scale-aware algorithm. A user-entered probe remains an explicit coordinate and must fail honestly when it is outside the documented tolerance; it must not be silently relocated.
- Keep canonical units and existing scale conversion behavior. Use epsilon-based geometric comparisons and record any projection distance/scale used for a default probe.
- Reuse `sparse_steady_thermal`; do not create another thermal solver-method string.
- Do not bump the project-file version or change persisted solver/result schemas. New UI-only draft or feedback state remains ephemeral unless an existing autosave field already owns it.

## Increment 1 — Make result display identity-safe

**Estimate: 0.75–1 day.**

1. Add a small pure selector, colocated with result selection or in a new result-display-state module, that accepts active project/study/run identity, summary, fields, and selected mode and returns whether results may be rendered.
2. In `WorkspaceApp.tsx`, centralize result invalidation in one function and call it before loading a project, switching study type, starting a replacement solve, or accepting a response with no compatible results.
3. Ensure result invalidation clears or rekeys:
   - `resultSummary` and `resultFields`;
   - active result mode/component/frame and playback state;
   - result playback/capture cache selection;
   - result probes or other run-bound annotations;
   - the viewer's effective results mode.
4. Pass the eligibility decision into `CadViewer.tsx`. Render `ResultLegend` and result-colored geometry only when eligible; otherwise render the ordinary model even if the workflow step is Results.
5. Keep the Results step's existing empty-state guidance. Do not synthesize neutral fields or carry a previous analysis mode into a different study type.

Focused coverage:

- Add pure selector tests for matching, missing, stale-run, wrong-study-type, and empty-field states.
- Extend `CadViewer.results.test.ts` to prove the legend and contour path are absent when eligibility is false.
- Extend `App.workflow.test.ts` with solved thermal → unsolved dynamic and solved static → unsolved thermal transitions; assert no stale unit, legend, field, frame, or probe survives.
- Cover a superseded asynchronous project response so a late result cannot re-enable stale visualization.

Acceptance:

- At no point after a project/study change can a stale `°C`, `MPa`, displacement, modal, or heat-flux legend be visible.
- Returning to a study with genuinely persisted compatible results still restores those results through the normal load path.

## Increment 2 — Put sample changes behind one confirmation

**Estimate: 0.5 day.**

1. Add `pendingAnalysisType` beside `pendingSampleModel` in `ModelPanel` and synchronize both only when the committed parent values change.
2. Make sample cards and analysis-type buttons update draft state and cancel any armed confirmation when the selection changes.
3. Update the preview copy, setup summary, selected button state, and load-button label from the draft pair.
4. On the second confirmation click, call `onLoadSample(pendingSampleModel, pendingAnalysisType)` once. Only the successful parent load commits `sampleModel` and `sampleAnalysisType`.
5. Route card double-click/open behavior through the same confirmation flow, or remove the destructive shortcut if it cannot present the same warning accessibly.
6. Remove the `WorkspaceApp.tsx` wiring that invokes `handleLoadSample` directly from `onSampleAnalysisTypeChange`.

Focused coverage in `RightPanel.test.tsx` and `App.workflow.test.ts`:

- Selecting Static, Dynamic, Modal, or Thermal performs no load by itself.
- First Load click arms confirmation; second click loads exactly the drafted pair.
- Changing either draft cancels confirmation.
- Keyboard activation and card open behavior cannot bypass confirmation.
- A successful load resets the sample setup exactly once.

## Increment 3 — Make default convergence probes mesh-aware

**Estimate: 1–1.5 days.**

1. Distinguish probe intent in the convergence input: `system_default` versus `explicit`. Preserve backward compatibility when reading existing records by inferring current `primary_load` records as default only at the UI boundary, not by rewriting persisted history.
2. Derive the default target from the primary load's named-selection face when available; use `applicationPoint` only as a seed, because it may be expressed in a display/CAD frame that is not exactly on the solver surface.
3. During each prepared rung, resolve the system default to the nearest valid solver-surface triangle using the existing coordinate-scale candidates and closest-point algorithm. Compare distances with a diagonal-relative epsilon, never exact equality.
4. Establish a stable physical anchor from the first successful rung—face identity plus normalized/barycentric location where possible—and remap that anchor on later meshes. Do not independently pick unrelated nearest locations on each rung.
5. Store the resolved point, projection distance, coordinate scale, and surface identity in diagnostics so a convergence result is auditable.
6. Keep explicit probes on the current strict `mapPointToNearestSurfaceTriangle` tolerance. If they fail, report the coordinate, nearest distance, and allowed tolerance rather than silently projecting them.
7. If a generated mesh lacks the selected surface entirely, keep the rung failed/inconclusive with a precise mapping error; do not fabricate displacement.

Focused coverage in `meshConvergence.test.ts`:

- Reproduce the bracket seed `[-1.18, 2.53, 0]` against representative coarse/medium/fine solver surfaces.
- Verify mm↔m scale resolution, stable cross-rung anchoring, deterministic tie-breaking, degenerate/empty surfaces, and epsilon-boundary behavior.
- Verify explicit off-surface probes still fail and are never moved.
- Verify three completed rungs classify as apparent convergence or unconverged from numerical thresholds, rather than mapping-inconclusive.

Acceptance:

- The shipped bracket default completes all feasible convergence rungs without the current mapping error.
- The reported probe corresponds to the same physical load region across mesh densities.

## Increment 4 — Repair accessibility state and labels

**Estimate: 0.75 day.**

1. While editing a load, hide or inert the new-load editor so only one Magnitude and one Direction control remain in the accessibility tree. Prefer one visible task at a time over merely suffixing duplicate labels.
2. Give the edit form an accessible group name containing the load identity, and restore focus to the edited load row after Save or Cancel.
3. Add `aria-pressed` to true stateful toggles:
   - structural and thermal result-mode buttons;
   - Flip cut side;
   - Toggle mesh.
4. Keep momentary camera/fit/reset actions as ordinary buttons; do not label them as toggles.
5. Ensure visible active styling and the accessible pressed state are driven by the same boolean.

Focused coverage:

- Extend `RightPanel.test.tsx` for unique names, editing focus flow, and result-mode pressed state.
- Extend the relevant `CadViewer` component/source tests for mesh and cut-side pressed state.
- Run keyboard-only smoke checks at desktop and 390 px mobile widths.

## Increment 5 — Correct method copy and add log feedback

**Estimate: 0.5 day.**

1. Replace `solverMethodForStudy`'s thermal fallthrough with the existing shared solver-method formatter or add `sparse_steady_thermal` to its return type. Prefer calling the shared `unitDisplay.ts` logic so Run, Results, reports, and exports cannot drift again.
2. Add a transient Copy Logs state in `BottomPanel.tsx`: idle, copied, and failed. Await the clipboard promise, show `Copied` briefly on success, and provide an actionable error on rejection or missing clipboard support.
3. Announce the copy outcome through a polite `aria-live` region without moving focus. Clear timers on unmount and make repeated clicks restart the feedback window.

Focused coverage:

- Update `RightPanel.test.tsx` to assert all four canonical methods, including `sparse_steady_thermal`.
- Replace the source-string-only Copy Logs test with behavior coverage for clipboard success, rejection, unsupported environments, repeated clicks, and timer cleanup.

## Verification gates

Run after each increment:

```sh
pnpm --filter @opencae/web exec vitest run <focused-test-files>
pnpm typecheck
pnpm build
```

Do not run or modify solver baselines because this plan does not change solver math. Before release, repeat the production-browser matrix on a deploy preview, then smoke-test production after deployment:

| Flow | Required checks |
| - | - |
| Static → Thermal → Dynamic → Modal | Draft analysis buttons do not reload; confirmed load does; unsolved Results never show stale contours/units. |
| Static convergence | Bracket default produces three mappable rungs; explicit invalid probe fails honestly. |
| Loads | Add/edit/cancel/save are keyboard reachable and expose unique accessible names. |
| Results | Every result-mode toggle reports pressed state; mesh and cut-side controls match visual state. |
| Run/provenance | Thermal shows `sparse_steady_thermal`; other methods remain unchanged. |
| Logs | Copy success and failure are visible and announced. |
| Regression | Static, dynamic, modal, and thermal local solves still complete; persistence, desktop/mobile layout, console health, and unit switching remain clean. |

Native Save As/export and STEP upload should be rerun manually in a browser that permits OS picker interaction. A future automated browser suite may inject the existing save adapter and set file inputs directly, but production picker behavior stays unchanged.

## Delivery order and commits

1. `Prevent stale result visualization`
2. `Confirm sample analysis changes`
3. `Stabilize convergence probe mapping`
4. `Fix workflow accessibility state`
5. `Correct solver labels and copy feedback`

Each commit must be independently typechecked and built, then pushed to the current branch. If an increment exposes a schema or numerical-contract change, stop and split it into a separately reviewed plan rather than broadening this remediation silently.

## Done definition

- All six confirmed production findings are fixed with focused regression coverage.
- The production E2E transition matrix passes with zero console errors or warnings caused by these flows.
- Existing saved projects open without migration and retain their real compatible results.
- No solver output, unit conversion, default mesh preset, public API, or file-format version changes.
- Native-picker limitations remain explicitly classified as manual-test coverage, not falsely marked fixed.
