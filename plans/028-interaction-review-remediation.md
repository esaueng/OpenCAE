# 028 — Interaction Review Remediation

## Status

Proposed on 2026-09-12 against `origin/main` at `9b32b410` (after PR #119), on
branch `claude/design-interaction-review-2026-09`. Stage 0 is executed on that
branch together with the plan document (the plan 027 precedent, PR #120).
Stage 1 is executed on `claude/plan-028-stage-1`, stacked on Stage 0: the
workspace notice and rail states (D7, D14, F7, F12, D4 as a named cleared-results
state), confirm-before-replace (D5, without the undo snapshot — undo holds the
project but not the display model, so restoring across a replacement needs a
geometry-aware snapshot first), provenance kept across reload (D9), mesh
preflight (D16), the mesh-not-restored notice (F13), and the start screen busy
state and Continue action (D23). Still open from Stage 1: keeping the previous
contours viewable while stale (the fuller D4).
Stage 2a is executed on `claude/plan-028-stage-2`, stacked on Stage 1: viewer
picks select and the panel button commits (F1), stale picks are cleared on
step change (F1), supports and loads can be moved to a newly picked face from
their edit forms (D3), the in-panel Next applies a previewed material (F3),
modal studies hide load markers and N/B skip the hidden Loads step (D17),
frame step buttons (F11) and the reverse-check caveat (F9). Still open from
Stage 2: assigned-face tinting and stable entry ids (F2), the real solver-surface
mesh view and size readout (D13, F5), offscreen report capture (D15), one
deformation control (D25), the legend peak marker (F8) and callout collision
handling (D20) — all viewer work.
Stage 2b is executed on `claude/plan-028-stage-2b`, stacked on 2a: the Mesh
step draws the generated volume mesh's boundary (`solverSurfaceMeshFromModel`
over the stored Core model, rendered through the same footprint transform the
results use) with a Show/Hide mesh toggle, and the decorative wireframe boxes
are gone (D13); the panel states the target element size instead of the
heuristic sample count (F5); report-figure capture announces itself in the
viewer and holds the result-mode controls while it runs (D15, an honest
interim — the capture still uses the live viewer); the deformation slider
appears in every structural mode and says it multiplies the legend factor
(D25); the legend prints the unaveraged element peak beside the averaged range
(F8). A new item found while verifying: **D27** run eligibility depends on
`displayModel.dimensions`, which the viewer measures after its first frame, so
a run started before the 3D view has painted was refused with "requires usable
block-like display dimensions".
Stage 2c is executed on `claude/plan-028-stage-2c`, stacked on 2b: STEP faces
that carry a support (teal) or a load (amber) stay tinted on the model (F2,
tinting only — stable entry ids remain open); every load callout goes through
`layoutOutsideModelLabels`, so two loads on one face no longer overprint
(D20); Run explains the missing measurement in plain words instead of
surfacing the solver refusal (D27, message only).
Stage 2d (`claude/plan-028-stage-2d`, stacked on 2c) closes D27 properly:
STEP uploads and parametric parts carry their bounding size from the face
registry measured at upload, so the run gate no longer depends on the viewer's
first frame. Still open in Stage 2: true offscreen capture.
Stage 3a (`claude/plan-028-stage-3a`, stacked on 2d): support and load labels
are assigned once at creation and stored in `parameters.label`, so they never
renumber (stable ids); an edit after a solve keeps the previous contours
viewable and marks them outdated on the legend, the pill, the rail and the
notice, and report/PNG/HTML/CSV/VTU refuse them until the next run (the
fuller D4; the flag persists across reload); wheel zoom targets the cursor
(F18 quick win). Still open: undo across geometry replacement, true offscreen
capture, and the Stage 3 product decisions (multi-face and named selections
next, then the study summary drawer; analysis-type placement and per-body
materials await a call).

Source: the design and interaction review of 2026-09-12, driven in the running
app (dev server, 1440×900, 1024×700, 375×812, both themes) across a blank
project with parametric parts, an STL upload, and the Bracket Demo in static,
dynamic, modal and thermal studies, including edits and load cases after
solving. Every finding below was reproduced live and traced to source unless
marked *source-only*. The full report with steps, evidence and acceptance
criteria is published as the "OpenCAE Interaction Review" artifact; this plan
carries what an executor needs.

## Diagnosis

The workflow spine (rail, readiness, provenance rows, validated inputs) is
sound. What is missing is the **feedback layer between an action and the
study's state**: edits destroy results silently, geometry replacement wipes
the setup without asking, failures render only on the panel where they
happened, and the rail reports presence rather than validity. Several setup
paths let a study look ready while the solver ignores or rejects part of it.

## Findings index

Priorities: P1 = incorrect setup, misleading interpretation, lost work or
blocked progress; P2 = costs time or trust; P3 = polish. Scope: XS < ½ day,
S = 1–2 days, M < 1 week, L = multi-week. Paths are relative to
`apps/opencae-web/src` unless they start with `libs/`.

| ID | P | Scope | Finding | Cause |
| - | - | - | - | - |
| D1 | P1 | S | "Prescribed displacement" support has no value fields, is skipped by the solver, passes readiness, then mesh fails with "could not map selection FS1 … re-select the face" | `SupportEditForm` (RightPanel.tsx ~1497-1516) passes `parameters` unchanged; adapter skips non-fixed constraints (`libs/opencae-core-adapter/src/index.ts:844`) and falls back to a literal `FS1` ref (`:265`, `:1926`) |
| D2 | P1 | S | Repeated Add stacks duplicate loads/supports on the same face (500 N intent → 1000 N applied) | `addSupport` (lib/api.ts:609) and `addLoadForFace` (WorkspaceApp.tsx ~1920) have no dedupe; only the viewer-click path does (`:1902-1907`) |
| D3 | P1 | M | Supports/loads cannot be re-targeted; a pick while editing adds a new support | `PlacementReadout` read-only in both edit forms; `handleViewportFaceSelect` (`:1879`) has no edit branch |
| D4 | P1 | M | Any edit destroys results; the only notice is one log line; pill stays "Ready" | `updateStudy` (`:1774-1777`) + `BottomPanel.tsx:291` renders only the classified pill |
| D5 | P1 | S | Upload/parametric add wipes material, supports, loads, mesh, results and undo without confirmation | `attachUploadedModelToProject` (localProjectFactory.ts:549-566); `openProjectResponse` clears undo (`:1324`) |
| D6 | P1 | S | STL/OBJ: placeholder mesh marked complete, Run enabled, run fails blaming the browser build | `canMeshStudyOnDemand` (lib/wasmMeshing.ts:24-31); `generateMesh` fallback (lib/api.ts:507-526); throw at `:1077` |
| D7 | P1 | M | Run/mesh failures visible only inside the Run/Mesh panels | alerts at RightPanel.tsx:1965 and 1624-1631; no global surface |
| D8 | P1 | XS | `formatDisplayNumber` prints 0.00143 mm as "0.001 mm" (1 significant digit) while 0.000958 prints 4 | unitDisplay.ts:362-371 |
| D9 | P1 | S | Reload relabels computed results "Estimate (not FEA)" | autosave restore runs `parseResultBundle` → `normalizeImportedResultSummary` (appPersistence.ts:373, 437-449) |
| D10 | P1 | S | An enabled load case with zero loads is solved: SF 2.8e12, "Unlikely to yield" | `libs/opencae-study-core/src/index.ts:218` requires only one non-empty case |
| D11 | P2 | XS | Safety-factor copy "Red areas have higher safety factor" is inverted vs `SAFETY_RAMP` | `resultModeExplanation` one template for all modes (RightPanel.tsx ~2914-2931) |
| D12 | P2 | XS | Thermal boundary ignores the typed temperature on face pick | `addFixedSupportForFace` hard-codes 20 °C (`:1912-1914`) |
| D13 | P2 | M | "Toggle mesh" never shows the generated FE mesh (null for uploads, fake boxes for samples) | `MeshOverlay` (CadViewer.tsx ~6969-7009) |
| D14 | P2 | S | Rail dots = presence, not readiness; seeded sample runs keep Run/Results ticked with an empty panel | StepBar.tsx:35-43 vs runReadiness.ts |
| D15 | P2 | M | Report-figure capture drives the live viewer through modes after every solve | report/captureResultViews.ts:88-120; trigger WorkspaceApp.tsx ~1622 |
| D16 | P2 | S | Mesh stage fails on boundary-condition validation in solver jargon | `libs/opencae-mesh-intake/src/coreModelFromMesh.ts:321`; adapter `:1046` |
| D17 | P2 | S | Modal: N key reaches hidden Loads ("Step 0 of 6"); load arrow stays visible | `workflowStepForShortcut` (appShellState.ts:29-43) |
| D18 | P2 | S | Imperial converts temperature but not heat flux/heat rate; boundary temperature input always °C | unitDisplay.ts:87, 189-193; RightPanel.tsx:751 |
| D19 | P3 | S | Legend, probes, range text, yield sentence and convergence inputs each round differently | toPrecision(6) paths; `formatAssessmentNumber`; `String(value)` seeds |
| D20 | P3 | S | Callouts for two loads on one face overprint | calloutLabelLayout not applied to identical anchors |
| D21 | P3 | XS | Copy: thermal load list "point load · Global -Z direction"; "Envelope · envelope"; "a ultra-dense"; sample direction vocabulary drift | RightPanel.tsx:1204, 2643, 2097; Model panel preconfigured copy |
| D22 | P3 | XS | Checkboxes named "on"; type cards, modal mode buttons and process radio unnamed; modal leaves the panel focusable | RightPanel/SimulationWorkflow/WorkspaceApp markup |
| D23 | P3 | S | Start screen: no busy state on Create; no "Continue last project"; Create overwrites autosave silently | App.tsx:70-86; `homeRequested`; StartScreen |
| D24 | P3 | XS | Empty viewer shows "Preparing the 3D view…" with no model; last-step Next looks live | CadViewer.tsx:427-431; WorkflowNav |
| D25 | P3 | S | Deformation slider "1.8x" vs legend "x15,340"; slider only in Stress mode | resultDeformation.ts:54-85; RightPanel.tsx:2801 |
| D26 | P2 | XS | *source-only:* orbit drag ending on the same face fires `onClick` and adds a support | R3F 8.18 dispatches click to initial hits regardless of delta; `pickHandlers.onClick` has no delta guard (CadViewer.tsx:1771-1777) |

Friction items F1–F18 and suggestions S1–S8 are in the report; the ones this
plan schedules are named in the increments.

## Increments

### Stage 0 — Quick refinements (this branch)

Correctness guards and number/word fixes, each with a pinned test:

1. **D1** — remove `Prescribed displacement` from the support-type select until
   the solver implements it; existing studies that carry the type render a
   warning row and count as a readiness blocker.
2. **D2** — `addSupport` refuses a second support on the same selection;
   `Add load` refuses an identical load (same selection, type, direction) with
   the message "A {type} of {value} {units} is already applied to {face}. Edit
   it to change the magnitude."
3. **D10** — validator emits `Load case {name} is enabled but has no loads.
   Add a load or disable it.` as a run blocker.
4. **D12** — the thermal pick uses the typed draft temperature.
5. **D6** — a readiness pseudo-item `Meshable geometry (STEP)` blocks Run for
   STL/OBJ display models; the Mesh panel explains instead of generating a
   placeholder; the import notice says the format is preview-only.
6. **D26** — ignore viewer clicks whose pointer travelled more than a few
   pixels.
7. **D8 / D19** — `formatDisplayNumber` guarantees at least three significant
   digits; legend ticks, probe readings, the automatic-range line, the yield
   sentence and convergence probe seeds use it.
8. **D11** — mode-specific colour explanations.
9. **D21, D18** — copy fixes; thermal panels state which units do not convert.
10. **D22** — accessible names for checkboxes, type cards, mode buttons and
    the process radio.

Exit: unit tests for each item; `pnpm typecheck` and the web suite pass.

### Stage 1 — The feedback layer (1–2 weeks)

- One notification surface: toast + inline alert + rail badge (D7); user
  language for pill states (F12).
- Stale-results state keeping the last contours viewable with the change named
  and a Re-run action (D4); reload preserves provenance and import diagnostics
  render in the panel (D9); "mesh not restored" notice on reopen (F13).
- Three-state rail from readiness with visible blocker text (D14, F7);
  readiness preflight before meshing with plain messages (D16);
  confirm-before-destroy for geometry replacement with an undo snapshot (D5);
  start-screen busy state and "Continue last project" (D23).

### Stage 2 — Selection and mesh visibility (2–4 weeks)

- Select-then-act: picks select, the panel commits (F1); re-target during edit
  (D3); tint assigned faces and stabilise entry ids (F2); apply material on
  Next (F3); modal loads dimmed, shortcuts filtered (D17).
- Real solver-surface edges in the Mesh step with size/count readout and an
  oversized-preset warning (D13, F5).
- Results coherence: offscreen report capture (D15); one deformation control in
  every mode (D25); peak marker on the legend (F8); frame step buttons (F11);
  reverse-check caveat (F9); callout collision handling (D20).

### Stage 3 — Larger interaction changes (product decisions)

Multi-face and named selections, per-body materials (F4); study summary drawer
(S1); analysis-type placement and results-loss warning on switch (F6); thermal
panel parity (F16); camera upgrades (F18); in-workspace sample gallery (S8);
report preview (S7).

## Not audited

Mouse orbit/pan/zoom and hover (browser pane hidden), mesh/solve cancel and
mid-operation reload (every operation finished in under three seconds), export
outputs (downloads blocked), recent-projects handles, screen readers, touch.
