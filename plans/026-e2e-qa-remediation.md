# 026 — End-to-end QA remediation

## Status

**Executed** on 2026-07-25 on branch `plan/026-e2e-qa-remediation`, seven
commits (`d2eac0b`..`077729e`) from `main` at `66ec912`. All seven stages
landed. `pnpm typecheck`, `pnpm build`, `pnpm verify:perf`, and
`check:bundle` pass; `pnpm test` is **149 files / 1522 tests, all green**.

Two corrections to this plan's diagnoses, recorded rather than quietly
absorbed:

- **Finding 9 (start-screen flash)** blamed `shouldShowStartScreen`. Wrong:
  the restore path fills the workspace synchronously from the autosave memo,
  so that function never returns true on the first frame. The cause is one
  line up in `App.tsx` — `WorkspaceApp` is a lazy chunk whose Suspense
  fallback *was* the start screen. Fixed there instead.
- **Finding 2 (Stage 2)** needed unplanned work in `@opencae/study-core`:
  `validateStudy` had no thermal branch, so steady conduction fell through to
  the structural validator. Wiring the Run gate to the validator without
  `validateSteadyStateThermalStudy` would have refused valid thermal models
  (body selections, absent direction vectors, negative cooling flux).

Originally proposed against `main` at `66ec912` (clean working tree).

This plan turns the end-to-end testing report into work. The report was
produced against `main` at `a15bf97`, which is an ancestor of the current
`main` — twelve commits behind. Two of its thirteen findings were fixed by
plan [025](025-cleanup-and-refinement-pass.md) in the interval and are
**closed here, not scheduled** (see "Already landed"). The remaining eleven
were re-verified against the current tree before being written up below;
every one still reproduces.

This is a defect-remediation pass over the web app's display, validation,
persistence, and accessibility layers. It changes **no** solver numerics, no
units or coordinate conventions, no file formats, no routes, and no result
provenance. One display-formatting change (Stage 1) alters what numbers the
UI and the PDF report *print*; it must not alter any stored or solved value.

## Already landed — closed without work

The report's findings 7 and 8 describe a red `main` CI. Plan 025 Stage 1
resolved both, and this was re-confirmed on `66ec912`:

```
npx vitest run apps/opencae-web/src/performanceRewrite.test.ts libs/opencae-solve-pipeline/src/goldenParity.test.ts
→ 2 files passed, 23 tests passed
```

- **Finding 7 (solver golden-parity)** — `goldenParity.test.ts` now derives
  its physical-value tolerance from `SPARSE_ALGEBRA_POLICY.defaultRelativeResidualTolerance`
  instead of the hardcoded `1e-12`, and compares discrete convergence counters
  under a separate named policy. The comment block at
  [goldenParity.test.ts:39](libs/opencae-solve-pipeline/src/goldenParity.test.ts:39)
  records the two intentional solver changes (`63daf73` CG convergence
  reference, SSOR preconditioner) that moved which iterate the solver stops on.
  The report's recommendation — do not blindly refresh fixtures — was followed;
  no fixture was refreshed.
- **Finding 8 (playback performance contract)** — the stale
  `resultFields={resultFieldsForUi}` literal was replaced with an assertion on
  the actual invariant, so a conditional-prop refactor no longer fails it.

The report's remediation items 4 and 5 are therefore already done.

## Established baseline

Commands: `pnpm build:core`, `pnpm build`, `pnpm typecheck`, `pnpm test`,
`pnpm verify:perf`, `pnpm --filter @opencae/web check:bundle`. There is no
formatter and no ESLint; "lint" resolves to `tsc --noEmit`.

Constraints inherited from earlier plans and prior incidents that bound the
work below:

- **Never round result field data.** [unitDisplay.ts:116](apps/opencae-web/src/unitDisplay.ts:116)
  documents why `resultFieldForUnits` converts without rounding: quantizing
  sub-0.01 displacement fields onto a 0.001 grid crumples the deformed shape
  (fixed in PR #42). Stage 1 must extend the *summary* path toward that same
  policy and must not walk it back for fields.
- **`appCss.test.ts` pins CSS literals.** Any `app.css` edit in Stage 5 has to
  be reconciled with that test rather than around it.
- **The report PDF is verified by hand.** `report/reportData.ts` is one of only
  two `roundDisplayValue` consumers; Stage 1 changes what it prints, so a
  generated PDF is part of that stage's acceptance.

## Verified findings driving the work

Each entry states what was re-confirmed in the current tree, and — where the
report's stated cause was incomplete — the sharper cause found on re-check.

### 1. Imperial displacement prints as exactly zero (report #1, High)

[`roundDisplayValue`](apps/opencae-web/src/unitDisplay.ts:310) rounds every
magnitude below 10 to three decimals, and `summaryForUnits` applies it to the
*numeric* value after unit conversion, not at format time. `0.001 mm` →
`0.00003937 in` → `0`. The same function is applied to
`summary.energyBalanceRelativeError * 100` at
[reportData.ts:299](apps/opencae-web/src/report/reportData.ts:299), so a
converged thermal balance error of `1e-6` prints as `0 %` in the PDF — the
same defect on a second surface, which the report did not reach.

This is the destructive-rounding class the field path already rejects. The fix
direction is the one already documented in `unitDisplay.ts`: convert only,
format at display time.

### 2. Negative load passes the editor and the readiness gate (report #2)

Two independent defects, not one:

- **The domain validator is not wired to the UI.** `@opencae/study-core`
  already emits `validation-load-value-<id>` when
  `!isPositiveFinite(load.parameters.value)`
  ([index.ts:69](libs/opencae-study-core/src/index.ts:69)). But `validateStudy`
  appears in `apps/opencae-web/src` **only inside `localProjectFactory.test.ts`**
  — never at runtime. The Run gate uses
  [`readinessForStudy`](apps/opencae-web/src/WorkspaceApp.tsx:2926), whose load
  check is `done: Boolean(study?.loads.length)` — presence, not validity. And
  [`LoadEditForm`](apps/opencae-web/src/components/RightPanel.tsx:1180) renders
  an unconditionally enabled Save at line 1300. A correct, tested validator
  exists and nothing calls it.
- **The stale footer status is a message-text classifier bug, not missing
  cleanup.** [`statusForDisplay`](apps/opencae-web/src/components/BottomPanel.tsx:336)
  derives the footer from the last log message's *text*. The solver's rejection
  reads `OpenCAE Core requires a load with a finite positive value and
  direction` — it contains `opencae core` but matches none of
  `error|fail|failed|unavailable|not configured|not enabled|not ready`, so it
  falls through to `OpenCAE Core active`. There is no run state to reset; the
  classifier mislabels a failure as health. Any future error phrased outside
  that word list is mislabelled the same way.

### 3. Undo/redo reports a persistence error (report #3)

[`persistProjectSnapshot`](apps/opencae-web/src/WorkspaceApp.tsx:2174) calls
`saveStudyPatch(snapshotStudy.id, snapshotStudy, message)` — three arguments.
`saveStudyPatch` is `updateStudy` ([lib/api.ts:700](apps/opencae-web/src/lib/api.ts:700)),
whose fourth parameter `currentStudy` is optional in the signature but required
at runtime: `if (!currentStudy) throw new Error("Could not update study without
an open study.")`. Every other call site passes it — e.g.
[WorkspaceApp.tsx:1923](apps/opencae-web/src/WorkspaceApp.tsx:1923). Undo and
redo therefore always throw, always log a failure, and always leave "Needs
attention"; the visible state change is React-local and survives only because
the persistence layer is a no-op pass-through in this local-first build.

The optional-but-required parameter is the underlying trap: the type system
cannot catch the next occurrence.

### 4. Invalid dynamic time stays visible while the old value is used (report #4)

[`DynamicNumberField.commitDraft`](apps/opencae-web/src/components/RightPanel.tsx:1869)
does `if (parsed === null) return;` — it discards the invalid parse silently
while `editing` keeps the rejected draft on screen. Estimated frames continues
to reflect the last committed value, so the field and the computation disagree
with no indication which one Run will use.

### 5. Support-editor Cancel drops focus to `BODY` (report #10)

`LoadEditorList` restores focus deliberately —
`window.requestAnimationFrame(() => loadItemRefs.current.get(loadId)?.focus())`
at [RightPanel.tsx:1092](apps/opencae-web/src/components/RightPanel.tsx:1092).
[`SupportEditorList`](apps/opencae-web/src/components/RightPanel.tsx:1339) has
no equivalent: `onCancel={() => setEditingId(null)}` unmounts the form and the
originating **Edit support** button at line 1376 is never refocused.

### 6. Load rows nest a button inside a `role="button"` (report #11)

[RightPanel.tsx:1123](apps/opencae-web/src/components/RightPanel.tsx:1123)
makes the whole row `role="button" tabIndex={0}`, and the native
**Remove support/load** button sits inside it. Nested interactive content is
invalid regardless of the keyboard behaviour working. Confirmed for structural
and thermal loads.

### 7. Project rename input has no accessible name (report #12)

[WorkspaceApp.tsx:2775](apps/opencae-web/src/WorkspaceApp.tsx:2775) renders
`className="breadcrumb-chip breadcrumb-input"` with no `aria-label`, no label
element, and no `aria-labelledby`.

### 8. Compact controls below the 24 px target benchmark (report #13)

WCAG 2.2 SC 2.5.8 (Target Size, Minimum) is the benchmark the report applied.
Confirmed in CSS: `.brand-button` has `padding: 0` around an 18×18 icon
([app.css:1213](apps/opencae-web/src/styles/app.css:1213)); `.viewer-view-presets
button` has `padding: 3px 8px` at `--fs-xs`, measuring ~22 px
([app.css:4750](apps/opencae-web/src/styles/app.css:4750)); `.beta-tag` and
some footer links sit at 16–17 px. Adjacent-target spacing is the alternative
conformance route where enlarging would break the compact desktop layout.

### 9. Autosave restoration flashes the start screen (report #6)

[`shouldShowStartScreen`](apps/opencae-web/src/appShellState.ts:12) returns
`homeRequested || !hasProject || !hasDisplayModel`. It has no notion of "restore
in flight", so the first frame after reload is always the start screen until the
async restore resolves. The function is pure and directly unit-tested
(`appShellState.test.ts`), so the fix is a new input plus new cases, not a
refactor.

### 10. Upload copy omits OBJ (report #5)

The input accepts `.step,.stp,.stl,.obj`
([RightPanel.tsx:337](apps/opencae-web/src/components/RightPanel.tsx:337)) but
the adjacent Callout at line 349 and the unsupported-format message at line 351
both say "STEP, STP, or STL". README and the user guide list OBJ.

### 11. Payload budgets cover only initial JS (report #9)

The report's 500 KB threshold is the tester's, not the repo's. The repo enforces
one budget — `INITIAL_JS_GZIP_BUDGET_BYTES = 175 * 1024` in both
[check-web-bundle-budget.mjs:7](scripts/check-web-bundle-budget.mjs:7) and
[verify-web-performance.mjs:8](scripts/verify-web-performance.mjs:8) — and it
**passes** at 64,527 gzip bytes, with 63% headroom. So this is not a regression
and nothing is currently over an agreed limit.

What is real is the absence of any gate on the lazy and precached tiers:
`viewer-three` 979 KiB raw, OCCT wasm 7.4 MiB, compressed gmsh wasm 11.0 MiB,
two showcase PNGs at ~850 KiB each, and a 26.2 MiB service-worker precache. The
two PNGs are straightforwardly wrong-sized; the wasm engines are intrinsic and
the question is only whether they belong in the *install-time* precache. Treat
this as "declare the budgets that exist and fix what is cheap", not as a
size-reduction project.

## Stages

Each stage is one commit and ends with `pnpm typecheck` plus the tests it
touches. The full suite, `pnpm build`, and `pnpm verify:perf` run after the
last stage.

### Stage 1 — Preserve converted magnitudes; format at display time

1. Stop rounding numeric values in `summaryForUnits`. Carry the full converted
   double through, matching the policy `resultFieldForUnits` already states.
2. Introduce one display formatter that chooses fixed decimals, significant
   figures, or exponent notation by magnitude, so a nonzero quantity never
   prints as `0`. Give it its own unit tests, including the report's case
   (`0.001 mm` → in) and the thermal `energyBalanceRelativeError * 100` case.
3. Move `report/reportData.ts`'s twelve `roundDisplayValue` call sites onto the
   same formatter. Where the value is already being interpolated into prose,
   format it once at that point rather than rounding the number first.
4. Retire `roundDisplayValue`, or keep it only where a genuinely coarse value is
   wanted, with a comment saying which.

Acceptance: no summary or report quantity prints `0` for a nonzero input;
`pnpm test` green; a generated report PDF is reviewed by hand — this is the
stage most likely to change a printed number somewhere unexpected. Stored
values, solved values, and result fields are byte-identical.

### Stage 2 — Make the existing validator authoritative

1. Call `validateStudy` from the readiness path so `readinessForStudy` reports
   a load as done only when the domain validator has no diagnostic for it.
   Prefer deriving the readiness list from diagnostics over adding a second,
   parallel set of checks — a duplicated rule is how the two drifted apart.
2. Block Save in `LoadEditForm` on a non-positive or non-finite magnitude, with
   `aria-invalid` and an inline message naming the constraint. Do the same for
   the other numeric fields in that form that the validator constrains.
3. Fix `statusForDisplay`: classify run outcome from the run's own state, not by
   pattern-matching prose. If the log-derived string must stay for now, make the
   failure path set an explicit status rather than relying on the message text
   containing a matching word.

Acceptance: entering `-1` disables Save with a visible reason; Run does not
become ready; a solver rejection shows a failure status in the footer. Add a
regression test for the readiness/validator agreement and one for
`statusForDisplay` on a rejection message that contains no word from the old
list.

### Stage 3 — Fix undo/redo persistence and close the signature trap

1. Pass the current study to `saveStudyPatch` in `persistProjectSnapshot`, or
   route undo/redo through whatever path the ordinary edits use.
2. Make `currentStudy` non-optional in `updateStudy` (and in the sibling
   `addLoad`/`addSupport`/… functions that throw on the same condition), so the
   compiler rejects the next three-argument call instead of the runtime doing it.
   If any caller genuinely cannot supply it, that call site is the bug.

Acceptance: undo and redo log success and leave the status Ready; a regression
test covers undo/redo persistence; `pnpm typecheck` passes with the parameter
required.

### Stage 4 — Surface invalid dynamic-setting drafts

Track validity in `DynamicNumberField`: mark the input `aria-invalid`, show the
constraint, and either disable Run while an invalid draft is held or restore the
committed value immediately. Estimated frames must never disagree silently with
what the field displays.

Acceptance: `-1` in End time is visibly rejected; Run state and the displayed
value agree; unit test on the field's validity behaviour.

### Stage 5 — Accessibility repairs

1. Mirror the `LoadEditorList` focus-restoration pattern in `SupportEditorList`
   for both save and cancel.
2. Restructure the load row so Edit and Remove are siblings: a real `button`
   (or link) covering the summary area, with Remove outside it. Keep the
   existing keyboard behaviour and accessible names.
3. Give the breadcrumb rename input an accessible name and a brief editing hint.
4. Raise `.brand-button`, `.viewer-view-presets button`, `.beta-tag`, and the
   footer links to a 24 px minimum target at touch breakpoints, or provide the
   spacing-based alternative where the compact desktop layout must be preserved.
   Reconcile with `appCss.test.ts` rather than working around it.

Acceptance: `document.activeElement` returns to the originating Edit control;
no nested interactive elements in the accessibility tree; the rename textbox has
a name; measured targets meet 24 px or the documented spacing exception;
`appCss.test.ts` passes.

### Stage 6 — Remove the start-screen flash

Add a restore-pending input to `shouldShowStartScreen` and render a neutral
startup shell while restoration is in flight. Extend `appShellState.test.ts`
with the pending cases.

Acceptance: the first painted frame after reloading a saved project is not the
start screen; existing `appShellState` cases still pass.

### Stage 7 — Copy and payload budgets

1. Centralize the supported-import-format list in one exported constant and use
   it for the `accept` attribute, the upload Callout, and the unsupported-format
   message, so the three cannot drift again. Include OBJ.
2. Optimize the two showcase PNGs (~850 KiB each).
3. Add explicit, named budgets alongside the initial-JS budget for the largest
   lazy chunks and for total service-worker precache size, set at current
   measured values plus a stated margin, so growth is caught. Record in the
   script why the wasm engines are exempt from a shrink target.
4. Decide — and record — whether the OCCT and gmsh wasm payloads belong in the
   install-time precache or should be cached on first use. If the answer is
   first-use, that is its own change with its own offline-PWA verification
   (`scripts/verify-offline-pwa.mjs`), not part of this stage.

Acceptance: `pnpm verify:perf` and `check:bundle` pass with the new budgets
declared; the format list has one source; PNG sizes reduced with no visible
quality loss.

## Explicitly out of scope

Solver algorithm, tolerance, or fixture changes; units, coordinate conventions,
DOF limits, file formats, and result provenance; backend retirement and the
`CadViewer.tsx` / `WorkspaceApp.tsx` / `RightPanel.tsx` decomposition (plan 024);
the deferred major dependency cohorts (plan 025); `packages/viewer`
adoption-or-deletion; reducing the wasm engine payloads themselves.

## Coverage gaps carried forward

The report could not verify these, and this plan does not close them. They are
listed so the next QA pass does not rediscover them as findings:

- **Browser CAD upload through the rendered picker** — the automation could not
  drive the file input. Repository STEP tests pass, but no real file was
  imported interactively.
- **Export file contents** — CSV reached a native save dialog and timed out;
  PDF, PNG, HTML, CSV, and VTU outputs were never opened. Stage 1 changes what
  the PDF prints, which makes this gap more pressing, not less.
- **Other browsers and assistive technology** — Safari, Firefox, physical touch
  devices, and VoiceOver were unavailable. Stage 5's conclusions rest on DOM
  geometry and the accessibility tree, not on a screen reader.
- **Large real-world CAD and Ultra-fidelity solves**, slow-network profiling,
  heap-growth measurement, full performance traces, and deliberately conflicting
  concurrent edits.
