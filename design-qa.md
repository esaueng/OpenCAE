# Design QA: Run Controls

- Source visual truth: browser annotations for `Save project` and the Run-panel `Analysis type` region; supporting capture at `/var/folders/t_/tvn84c292rzdfcbj06vltnsw0000gn/T/codex-clipboard-62f3d5b2-ae6c-4efb-915f-dbbee39f71b1.png`
- Implementation screenshot: `/private/tmp/opencae-run-controls-live.png`
- Viewport: 1949 x 1606 desktop; responsive geometry also checked at 390 x 844
- State: dark theme, Dynamic Bracket Demo, Run step, Dynamic selected

## Full-view comparison evidence

The annotated source and deployed implementation were opened together. The surrounding top bar, workflow rail, 3D viewer, Run-panel hierarchy, typography, colors, field density, and navigation remain consistent. The two requested differences are visible: the top-bar action now reads `Download Project` with a download icon, and the four analysis types occupy a balanced 2 x 2 grid instead of leaving two empty cells beside `Thermal`.

## Focused region comparison evidence

The controls are readable in the full-resolution captures, so a separate crop was not needed. Browser geometry independently confirmed the deployed analysis group is 311 px wide with two equal 154.5 px columns. `Static` and `Dynamic` occupy the first row; `Modal` and `Thermal` occupy the second. The top-bar action exposes matching visible text and accessible name, `Download Project`, with the title `Download project to local disk`.

## Required fidelity surfaces

- Fonts and typography: unchanged; existing IBM Plex Sans and monospace hierarchy, weights, sizes, line heights, and truncation behavior are preserved.
- Spacing and layout rhythm: only the selected controls changed. The analysis group retains its 62 px height, 30 px controls, radius, and panel spacing while redistributing the options evenly across two columns.
- Colors and visual tokens: unchanged; existing surface, border, text, active-accent, and semantic colors are reused.
- Image quality and asset fidelity: no raster assets were added or changed. The project action uses the existing Lucide icon library.
- Copy and content: the selected top-bar label is now exactly `Download Project`; analysis labels and all adjacent Run settings remain unchanged.

## Findings

No actionable P0, P1, or P2 mismatch remains.

## Comparison history

1. Initial findings: the project action read `Save project`; the four analysis types used a three-column grid, leaving visible empty space in the second row.
2. Fixes: changed the action copy, accessible name, title, and icon to the download treatment; scoped a two-column grid and internal row/column dividers to the Run-panel selector only.
3. Post-fix evidence: the deployed screenshot shows the requested label and balanced grid. Production geometry reports two equal columns, four equal 30 px controls, and zero horizontal document overflow.

## Interaction and runtime checks

- Primary flow: start screen -> sample menu -> Dynamic -> load Bracket Demo -> Run.
- Interaction result: selecting `Modal` changed the pressed state, removed Dynamic settings, and displayed Modal settings; selecting `Dynamic` restored the original state.
- Responsive result: at 390 x 844 the selector remained a two-column grid with 129 px columns and no horizontal overflow; the download action remained accessible while its text collapsed under the existing compact top-bar rule.
- Production result: `cae.esau.app` loaded `Download Project` and the 2 x 2 selector from Cloudflare version `5e287837-2763-4b8c-b4bb-8b5ece210117` with no console errors or warnings.

final result: passed

# Design QA: Results Legend Resize Handle

- Source visual truth: current production Results view before this change, captured at `/private/tmp/opencae-legend-handle-before-matched.png`
- Implementation screenshots: `/private/tmp/opencae-legend-handle-after.png` at the default size and `/private/tmp/opencae-legend-handle-expanded.png` after a down-right drag
- Viewport: 1280 x 720 desktop
- State: dark theme, Static Stress Bracket Demo, Results step, stress legend visible

## Full-view comparison evidence

The production reference and local implementation use the same viewport and Results state. The workflow rail, top bar, viewer, legend dimensions, typography, scale, and right-panel composition remain unchanged. The requested difference is isolated to the legend: its blue resize corner moves from the upper-right to the lower-right.

## Focused region comparison evidence

The full-resolution captures make the 360 x 159 px legend readable without an additional crop. Browser geometry confirms the 28 x 28 px handle shares the legend's right and bottom edges, uses the `nwse-resize` cursor, and is the topmost hit target at its center. The `Max` label remains visible because the extrema row reserves 20 px beside the handle.

## Required fidelity surfaces

- Fonts and typography: unchanged; all legend labels retain the existing monospace family, weights, and scale behavior.
- Spacing and layout rhythm: legend size and top-left placement are unchanged; only the handle anchor and the small right-side clearance on the extrema row changed.
- Colors and visual tokens: unchanged; the handle continues to use the existing accent color and legend tokens.
- Image quality and asset fidelity: no image or icon assets changed; the resize indicator remains the existing CSS corner treatment.
- Copy and content: all result values, labels, units, and accessible names remain unchanged.

## Findings

No actionable P0, P1, or P2 mismatch remains.

## Comparison history

1. Initial state: the resize corner was anchored to the legend's upper-right and vertical resizing grew opposite the drag direction.
2. First implementation: moved the corner to the lower-right, changed the cursor and corner border orientation, and made downward dragging increase height.
3. Interaction finding: the later-painted extrema row could intercept pointer input over the relocated corner, preventing the drag from starting.
4. Fix: raised the resize target above legend content with `z-index: 1` and kept `Max` clear with 20 px right padding.
5. Post-fix evidence: dragging from (481, 200) to (561, 260) resized the legend from 360 x 159 px to 440 x 219 px; the handle remained attached to the new bottom-right corner. Double-click restored the default size.

## Interaction and runtime checks

- Primary flow: start screen -> Static Bracket Demo -> Results -> drag the legend's lower-right resize corner down and right -> double-click the legend to reset.
- Interaction result: the legend grew by 80 px horizontally and 60 px vertically in the drag direction, then reset with no stale inline dimensions.
- Hit-target result: `elementFromPoint` at the handle center resolves to `.analysis-legend-resize`.
- Console result: no application errors; only the expected Plausible analytics `Ignoring Event: localhost` warning was present.
- Automated result: 139 focused tests passed and the full production build completed.

final result: passed

# Design QA: Sample Analysis Projects

- Source visual truth: the production sample-project picker before this change, captured at `/private/tmp/opencae-sample-menu-before.png`
- Implementation screenshots: `/private/tmp/opencae-sample-menu-after.png`, `/private/tmp/opencae-sample-thermal-run.png`, and `/private/tmp/opencae-sample-menu-mobile.png`
- Viewports: 1280 x 720 desktop and 390 x 844 responsive
- States: sample picker with Static selected; Modal Beam Demo; Thermal Bracket Demo at the Run step

## Full-view comparison evidence

The source and implementation captures preserve the existing centered start-screen composition, sample cards, typography, colors, and primary action. The intentional change is a second analysis row containing `Modal` and `Thermal`. Each analysis type retains the same three geometry choices, producing twelve built-in sample combinations without enlarging the surrounding cards.

## Focused region comparison evidence

The desktop picker is a 180 x 62 px two-column grid with four 30 px controls. The responsive picker preserves the same 2 x 2 arrangement and reports zero horizontal document overflow. Modal cards replace force details with `6 natural modes`; Thermal cards show `20 °C reference` and `10 kW/m² heat flux`.

## Required fidelity surfaces

- Fonts and typography: unchanged; the existing monospace control and metadata styles are reused.
- Spacing and layout rhythm: the selector adds one compact row while preserving the width and alignment of the sample cards and primary action.
- Colors and visual tokens: unchanged; existing active, border, surface, and semantic tokens are reused.
- Image quality and asset fidelity: existing procedural sample thumbnails are reused. Modal suppresses the misleading load arrow, while Thermal retains the face-direction cue.
- Copy and content: labels use `Modal` and `Thermal`; project headers use the full study names `Modal Analysis` and `Steady-State Thermal`.

## Findings

No actionable P0, P1, or P2 mismatch remains.

## Comparison history

1. Initial state: only Static and Dynamic were available in the sample-project picker.
2. Fixes: introduced shared four-mode options; added valid Modal and Thermal factories in the browser and API; added mode-specific metadata, summaries, and Run readiness.
3. Post-fix evidence: all four analysis types are present in a balanced grid; Modal and Thermal samples load across Bracket, Beam, and Cantilever geometries; desktop and responsive layouts do not overflow.

## Interaction and runtime checks

- Modal flow: sample menu -> Modal -> Beam Demo -> Run. The project loads with a fixed support, six requested natural modes, no force load, and an enabled Run action.
- Thermal flow: sample menu -> Thermal -> Bracket Demo -> Run. The project loads with a 20 °C prescribed-temperature reference, a 10,000 W/m² heat-flux load, completed readiness checks, and an enabled Run action.
- Schema result: every new geometry/analysis combination validates against `ProjectSchema`; `validateStudy` reports no diagnostics for Modal or Thermal samples.
- Responsive result: at 390 x 844, the analysis options remain in a two-column grid with no horizontal document overflow.
- Runtime result: local browser checks completed without application console errors; the only warning was the expected analytics suppression on localhost.

final result: passed
