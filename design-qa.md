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
