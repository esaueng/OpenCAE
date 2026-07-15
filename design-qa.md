# Design QA: Result Legend Placement

- Source visual truth: user browser annotation targeting the simulation-details legend; matched production capture at `/private/tmp/opencae-result-legend-before-matched.png`
- Implementation screenshot: `/private/tmp/opencae-result-legend-after-matched.png`
- Viewport: 1949 x 1606 desktop; responsive geometry also checked at 390 x 844
- State: dark theme, Dynamic Bracket Demo, Results step, default legend size

## Full-view comparison evidence

The matched production and local screenshots were opened together at the same viewport and workflow state. The source places the legend 12 px from the viewer's bottom-left. The implementation places the same unchanged legend 12 px from the viewer's top-left, matching the annotation while preserving the workflow rail, right Results panel, viewer controls, and footer.

## Focused region comparison evidence

A separate crop was not needed: at original resolution the complete legend is isolated against the viewer background and its typography, border, resize affordance, values, and color scale are legible in both matched screenshots. Browser geometry independently measured the implementation at `left: 12 px; top: 12 px` relative to `.viewer-shell`.

## Required fidelity surfaces

- Fonts and typography: unchanged; the existing monospace family, sizes, weights, line heights, and value hierarchy are preserved.
- Spacing and layout rhythm: the only intended difference is replacing the 12 px bottom inset with a 12 px top inset. Card size, internal spacing, radius, and resize behavior are unchanged.
- Colors and visual tokens: unchanged; the existing surface, border, text, warning, and result-scale colors remain intact.
- Image quality and asset fidelity: no image or icon assets were added, removed, regenerated, or substituted.
- Copy and content: unchanged; node and element counts, result type, units, tick labels, extrema, and deformation note use the existing component.

## Findings

No actionable P0, P1, or P2 mismatch remains.

## Comparison history

1. Initial finding: the selected legend was anchored at the viewer bottom-left, contrary to the requested top-left placement.
2. Fix: changed `.analysis-legend` from `bottom: 12px` to `top: 12px` while retaining `left: 12px`.
3. Post-fix evidence: desktop browser geometry reports a 12 px top and left inset; the 390 x 844 check reports the same 12 px inset, a 280 px legend width inside a 302 px viewer, and no horizontal document overflow.

## Interaction and runtime checks

- Primary flow: start screen -> sample menu -> Dynamic -> load Bracket Demo -> Results.
- Interaction result: Results becomes active and the legend renders in the upper-left of the 3D viewer.
- Console: no relevant application errors; one existing localhost analytics warning (`Ignoring Event: localhost`).

final result: passed
