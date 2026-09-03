import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const css = readFileSync(resolve(__dirname, "app.css"), "utf8");
const tokens = readFileSync(resolve(__dirname, "../theme/tokens.css"), "utf8");
const cadViewer = readFileSync(resolve(__dirname, "../components/CadViewer.tsx"), "utf8");
const appSource = readFileSync(resolve(__dirname, "../WorkspaceApp.tsx"), "utf8");
const lightThemeBlock = tokens.match(/\.theme-light\s*\{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? "";

function lightToken(name: string) {
  const match = lightThemeBlock.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match?.[1]) throw new Error(`Missing light token ${name}`);
  return match[1];
}

function luminance(hex: string) {
  const channels = hex.match(/[0-9a-fA-F]{2}/g)?.map((channel) => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  if (!channels || channels.length !== 3) throw new Error(`Invalid hex color ${hex}`);
  const [red, green, blue] = channels as [number, number, number];

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string) {
  const light = Math.max(luminance(foreground), luminance(background));
  const dark = Math.min(luminance(foreground), luminance(background));
  return (light + 0.05) / (dark + 0.05);
}

function cssRule(selector: string) {
  return css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{(?<body>[\\s\\S]*?)\\n\\}`))?.groups?.body ?? "";
}

describe("app CSS", () => {
  test("centers model import progress over the viewer", () => {
    const importOverlay = cssRule(".viewer-import-overlay");

    expect(cadViewer).toContain('aria-busy={props.importingModelFilename ? true : undefined}');
    expect(cadViewer).toContain('className="viewer-import-overlay" role="status"');
    expect(cadViewer).toContain("Large files may take a while.");
    expect(importOverlay).toMatch(/position:\s*absolute/);
    expect(importOverlay).toMatch(/inset:\s*0/);
    expect(importOverlay).toMatch(/place-items:\s*center/);
    expect(importOverlay).toMatch(/z-index:\s*var\(--z-viewer-import-overlay\)/);
    expect(tokens).toMatch(/--z-viewer-import-overlay:\s*20;/);
  });

  test("stacks app layers through the shared z-index scale", () => {
    // Every app-level layer resolves through a token so the stacking order is
    // readable in one place. Bare z-index values are still allowed for ordering
    // siblings inside a single component's stacking context.
    const scale = ["--z-base", "--z-viewer-overlay", "--z-log-drawer", "--z-viewer-import-overlay",
      "--z-modal-backdrop", "--z-condition-menu", "--z-popover", "--z-gallery-backdrop",
      "--z-tooltip", "--z-skip-link"];
    const depths = scale.map((name) => {
      const match = tokens.match(new RegExp(`${name}:\\s*(\\d+);`));
      if (!match?.[1]) throw new Error(`Missing z-index token ${name}`);
      return Number(match[1]);
    });
    expect(depths).toEqual([...depths].sort((left, right) => left - right));
    expect(new Set(depths).size).toBe(depths.length);

    const bareDepths = [...css.matchAll(/z-index:\s*(\d+);/gu)].map((match) => Number(match[1]));
    expect(bareDepths.every((depth) => depth === 1), `unnamed app layer depth in app.css: ${bareDepths.filter((depth) => depth !== 1).join(", ")}`).toBe(true);
  });

  test("does not ship the removed viewer reset HUD button styles", () => {
    expect(css).not.toContain(".viewer-hud");
    expect(css).not.toContain(".viewer-reset");
  });

  test("lightens the analysis legend in light mode", () => {
    expect(css).toMatch(/\.theme-light\s+\.analysis-legend\s*\{[\s\S]*?background:\s*rgba\(255,\s*255,\s*255,\s*0\.88\)/);
    expect(css).toMatch(/\.theme-light\s+\.analysis-legend\s*\{[\s\S]*?color:\s*var\(--color-text\)/);
    expect(css).toMatch(/\.theme-light\s+\.analysis-legend\s+\.legend-scale\s*\{[\s\S]*?border-color:\s*rgba\(82,\s*103,\s*130,\s*0\.24\)/);
  });

  test("makes the analysis legend larger by default with a bottom-right resize handle", () => {
    const analysisLegend = cssRule(".analysis-legend");
    const resizeHandle = cssRule(".analysis-legend-resize");
    const resizeHandleAfter = cssRule(".analysis-legend-resize::after");

    expect(analysisLegend).toMatch(/top:\s*12px/);
    expect(analysisLegend).toMatch(/left:\s*12px/);
    expect(analysisLegend).not.toMatch(/bottom:/);
    expect(analysisLegend).toMatch(/width:\s*360px/);
    expect(analysisLegend).toMatch(/min-width:\s*280px/);
    expect(analysisLegend).toMatch(/min-height:\s*154px/);
    expect(analysisLegend).toMatch(/max-width:\s*calc\(100%\s*-\s*24px\)/);
    expect(analysisLegend).toMatch(/max-height:\s*calc\(100%\s*-\s*24px\)/);
    expect(analysisLegend).toMatch(/overflow:\s*hidden/);
    expect(analysisLegend).toMatch(/resize:\s*none/);
    expect(analysisLegend).toMatch(/pointer-events:\s*auto/);
    expect(analysisLegend).toMatch(/align-content:\s*start/);
    expect(analysisLegend).toMatch(/font-size:\s*calc\(var\(--fs-mini\)\s*\*\s*var\(--analysis-legend-scale,\s*1\)\)/);
    expect(analysisLegend).toMatch(/gap:\s*calc\(6px\s*\*\s*var\(--analysis-legend-scale,\s*1\)\)\s+calc\(12px\s*\*\s*var\(--analysis-legend-scale,\s*1\)\)/);
    expect(analysisLegend).toMatch(/padding:\s*calc\(12px\s*\*\s*var\(--analysis-legend-scale,\s*1\)\)\s+calc\(14px\s*\*\s*var\(--analysis-legend-scale,\s*1\)\)\s+calc\(8px\s*\*\s*var\(--analysis-legend-scale,\s*1\)\)/);
    expect(resizeHandle).toMatch(/position:\s*absolute/);
    expect(resizeHandle).toMatch(/bottom:\s*0/);
    expect(resizeHandle).toMatch(/right:\s*0/);
    expect(resizeHandle).toMatch(/z-index:\s*1/);
    expect(resizeHandle).toMatch(/cursor:\s*nwse-resize/);
    expect(resizeHandleAfter).toMatch(/border-bottom:\s*2px\s+solid/);
    expect(resizeHandleAfter).toMatch(/border-right:\s*2px\s+solid/);
    expect(cssRule(".legend-extrema")).toMatch(/padding-right:\s*20px/);
  });

  test("scales result legend visual elements with resized content", () => {
    const legendScale = cssRule(".legend-scale");
    expect(legendScale).toMatch(/height:\s*calc\(10px\s*\*\s*var\(--analysis-legend-scale,\s*1\)\)/);
    expect(legendScale).not.toMatch(/background:/);
    expect(css).not.toContain(".analysis-legend.safety-scale");
    expect(cadViewer).toContain('style={{ background: resultScaleCssGradient(colorScale) }}');
    expect(cssRule(".legend-values")).toMatch(/font-size:\s*calc\(var\(--fs-mini\)\s*\*\s*0\.9\s*\*\s*var\(--analysis-legend-scale,\s*1\)\)/);
  });

  test("styles workspace keyboard shortcut hints", () => {
    const workflowNavButton = cssRule(".workflow-nav button");
    const workflowNavKbd = cssRule(".workflow-nav kbd");
    const shortcutGuide = cssRule(".shortcut-guide");
    const shortcutList = cssRule(".shortcut-list");
    const shortcutItem = cssRule(".shortcut-item");
    const shortcutKey = cssRule(".shortcut-key");
    const shortcutPopover = cssRule(".shortcut-popover");
    const shortcutBackdrop = cssRule(".shortcut-popover-backdrop");

    expect(workflowNavButton).toMatch(/display:\s*flex/);
    expect(workflowNavButton).toMatch(/justify-content:\s*space-between/);
    expect(workflowNavKbd).toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(workflowNavKbd).toMatch(/border:\s*var\(--border-thin\)/);
    expect(shortcutGuide).toMatch(/border:\s*var\(--border-thin\)/);
    expect(shortcutList).toMatch(/grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
    expect(shortcutItem).toMatch(/grid-template-columns:\s*auto\s+minmax\(0,\s*1fr\)/);
    expect(shortcutKey).toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(shortcutPopover).toMatch(/position:\s*absolute/);
    expect(shortcutPopover).toMatch(/box-shadow:\s*var\(--shadow-panel\)/);
    expect(shortcutBackdrop).toMatch(/position:\s*fixed/);
    expect(shortcutBackdrop).toMatch(/inset:\s*0/);
    expect(shortcutBackdrop).toMatch(/z-index:\s*var\(--z-modal-backdrop\)/);
  });

  test("keeps compact interactive controls at least 24px high", () => {
    expect(css).toMatch(/\.unit-switch\s+\.unit-toggle\s*\{[^}]*min-height:\s*24px/);
    expect(css).toMatch(/\.tooltip-trigger\s*\{[^}]*width:\s*24px[^}]*height:\s*24px/);
    expect(css).toMatch(/\.status-tabs\s+button\s*\{[^}]*min-height:\s*24px/);
  });

  test("keeps the Results export menu in the viewport instead of clipping it inside the mobile panel", () => {
    const floatingExportMenu = cssRule(".export-menu-popover.export-menu-popover--floating");

    expect(floatingExportMenu).toMatch(/position:\s*fixed/);
    expect(floatingExportMenu).toMatch(/right:\s*auto/);
    expect(floatingExportMenu).toMatch(/max-height:\s*calc\(100vh\s*-\s*24px\)/);
    expect(floatingExportMenu).toMatch(/overflow-y:\s*auto/);
  });

  test("balances the four Run analysis types in a two-column grid", () => {
    const runAnalysisType = cssRule(".segmented.run-analysis-type");
    const evenButtons = cssRule(".segmented.run-analysis-type button:nth-child(2n)");
    const firstRowButtons = cssRule(".segmented.run-analysis-type button:nth-child(-n + 2)");

    expect(runAnalysisType).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    expect(evenButtons).toMatch(/border-right:\s*0/);
    expect(firstRowButtons).toMatch(/border-bottom:\s*var\(--border-thin\)/);
  });

  test("balances the four sample analysis types in a two-column grid", () => {
    const sampleAnalysisType = cssRule(".segmented.sample-analysis-type-grid");
    const evenButtons = cssRule(".segmented.sample-analysis-type-grid button:nth-child(2n)");
    const firstRowButtons = cssRule(".segmented.sample-analysis-type-grid button:nth-child(-n + 2)");

    expect(sampleAnalysisType).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    expect(evenButtons).toMatch(/border-right:\s*0/);
    expect(firstRowButtons).toMatch(/border-bottom:\s*var\(--border-thin\)/);
  });

  test("keeps light mode shared text colors above contrast requirements", () => {
    const lightSurface = lightToken("--color-surface");
    const textTokens = ["--color-text", "--color-text-muted", "--color-text-subtle", "--color-accent", "--color-warning", "--color-error", "--color-success"];

    for (const token of textTokens) {
      expect(contrastRatio(lightToken(token), lightSurface), token).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("uses primary text for panel titles", () => {
    expect(cssRule(".panel-section h2")).toMatch(/color:\s*var\(--color-text\)/);
  });

  test("styles the beta release tag with blue accent colors", () => {
    const betaTag = cssRule(".beta-tag");

    expect(betaTag).toMatch(/color:\s*var\(--color-accent\)/);
    expect(betaTag).toMatch(/background:\s*var\(--color-accent-dim\)/);
    expect(betaTag).toMatch(/border:\s*1px\s+solid\s+var\(--color-accent-border\)/);
  });

  test("keeps the main start screen compact and stacks the sample submenu vertically", () => {
    const startScreen = cssRule(".start-screen");
    const startBrand = cssRule(".start-brand");
    const startBrandMenu = cssRule(".start-brand.sample-menu-open");
    const sampleMenuFooter = cssRule(".start-brand.sample-menu-open + .start-footer");
    const sampleGrid = cssRule(".start-sample-grid");
    const sampleGridCard = cssRule(".start-sample-grid .sample-option-card");

    expect(startScreen).toMatch(/overflow:\s*auto/);
    expect(startBrand).toMatch(/position:\s*relative/);
    expect(startBrand).toMatch(/width:\s*min\(340px,\s*100%\)/);
    expect(startBrandMenu).toMatch(/width:\s*min\(430px,\s*100%\)/);
    expect(sampleMenuFooter).toMatch(/display:\s*none/);
    expect(sampleGrid).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(sampleGridCard).toMatch(/min-height:\s*112px/);
  });

  test("uses the start screen background for the required simulation type screen", () => {
    const simulationTypeScreen = cssRule(".simulation-type-screen");
    const simulationTypeGrid = cssRule(".simulation-type-screen::before");

    expect(simulationTypeScreen).toMatch(/radial-gradient\(ellipse\s+80%\s+50%\s+at\s+50%\s+0%/);
    expect(simulationTypeGrid).toMatch(/background-size:\s*42px\s+42px/);
  });

  test("frames simulation showcase renders with native overlays", () => {
    const showcase = cssRule(".analysis-showcase");
    const showcaseImg = cssRule(".analysis-showcase img");
    const overlay = cssRule(".analysis-showcase-overlay");
    const activeShowcase = cssRule(".simulation-choice-card.active .analysis-showcase");

    expect(showcase).toMatch(/position:\s*relative/);
    expect(showcase).toMatch(/aspect-ratio:\s*2\s*\/\s*1/);
    expect(showcase).toMatch(/overflow:\s*hidden/);
    expect(showcaseImg).toMatch(/object-fit:\s*cover/);
    expect(overlay).toMatch(/position:\s*absolute/);
    expect(overlay).toMatch(/pointer-events:\s*none/);
    expect(activeShowcase).toMatch(/border-color:\s*color-mix\(in srgb,\s*var\(--color-accent\)\s*72%,\s*transparent\)/);
  });

  test("aligns all start screen footer text on one row", () => {
    const startFooter = cssRule(".start-footer");
    const startFooterItems = cssRule(".start-footer > *");
    const localRuntime = cssRule(".local-runtime");

    expect(startFooter).toMatch(/display:\s*grid/);
    expect(startFooter).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto\s*minmax\(0,\s*1fr\)/);
    expect(startFooter).toMatch(/align-items:\s*baseline/);
    expect(startFooterItems).toMatch(/color:\s*inherit/);
    expect(startFooterItems).toMatch(/font:\s*inherit/);
    expect(localRuntime).toMatch(/color:\s*inherit/);
  });

  test("styles the Ko-fi action as a bottom status link", () => {
    const donateLink = cssRule(".status-link.donate-link");
    const coffeeMark = cssRule(".coffee-mark");
    const coffeeLabel = cssRule(".coffee-label");
    const coffeeLetter = cssRule(".coffee-letter");
    const activeMug = cssRule(".donate-link.coffee-animating .coffee-mark svg");
    const activeSteam = cssRule(".donate-link.coffee-animating .coffee-steam");
    const activeSparkle = cssRule(".donate-link.coffee-animating .coffee-sparkle");
    const activeLetter = cssRule(".donate-link.coffee-animating .coffee-letter");

    expect(donateLink).toMatch(/color:\s*#ffd6a3/);
    expect(donateLink).toMatch(/text-transform:\s*none/);
    expect(coffeeMark).toMatch(/position:\s*relative/);
    expect(coffeeLabel).toMatch(/display:\s*inline-flex/);
    expect(coffeeLetter).toMatch(/--coffee-letter-index:\s*0/);
    expect(activeMug).toMatch(/animation:\s*coffee-mug-lift/);
    expect(activeSteam).toMatch(/animation:\s*coffee-steam-rise/);
    expect(activeSparkle).toMatch(/animation:\s*coffee-sparkle-pop/);
    expect(activeLetter).toMatch(/animation:\s*coffee-letter-wave/);
    expect(activeLetter).toMatch(/animation-delay:\s*calc\(var\(--coffee-letter-index\)\s*\*\s*28ms\)/);
    expect(css).toContain("@keyframes coffee-mug-lift");
    expect(css).toContain("@keyframes coffee-steam-rise");
    expect(css).toContain("@keyframes coffee-sparkle-pop");
    expect(css).toContain("@keyframes coffee-letter-wave");
  });

  test("only underlines start screen footer links on hover", () => {
    const startFooterLinks = cssRule(".start-footer a");
    const startFooterLinkHover = cssRule(".start-footer a:hover,\n.start-footer a:focus-visible");

    expect(startFooterLinks).toMatch(/text-decoration:\s*none/);
    expect(startFooterLinkHover).toMatch(/text-decoration:\s*underline/);
  });

  test("does not draw a focus outline around range sliders", () => {
    const rangeInput = cssRule(".range-field input[type=\"range\"]");
    const rangeFocus = cssRule(".range-field input[type=\"range\"]:focus,\n.range-field input[type=\"range\"]:focus-visible");

    expect(rangeInput).toMatch(/border:\s*none/);
    expect(rangeInput).toMatch(/padding:\s*0/);
    expect(rangeFocus).toMatch(/outline:\s*none/);
    expect(rangeFocus).not.toMatch(/outline-offset/);

    // The suppressed outline is a decision about WHERE the ring goes, not whether there
    // is one: the thumb carries it instead. Without these the sliders are keyboard
    // operable with no visible focus state at all.
    const webkitFocusThumb = cssRule('.range-field input[type="range"]:focus-visible::-webkit-slider-thumb');
    const mozFocusThumb = cssRule('.range-field input[type="range"]:focus-visible::-moz-range-thumb');

    expect(webkitFocusThumb).toMatch(/var\(--color-accent\)/);
    expect(mozFocusThumb).toMatch(/var\(--color-accent\)/);
  });

  test("styles playback time as a passive playhead instead of a draggable slider", () => {
    const playbackRange = cssRule(".range-field input.playback-time-range");
    const playbackTrack = cssRule(".playback-time-track");
    const peakMarker = cssRule(".playback-peak-marker");
    const playbackWebkitThumb = cssRule(".range-field input.playback-time-range::-webkit-slider-thumb");
    const playbackMozThumb = cssRule(".range-field input.playback-time-range::-moz-range-thumb");

    expect(playbackRange).toMatch(/cursor:\s*default/);
    expect(playbackTrack).toMatch(/position:\s*relative/);
    expect(peakMarker).toMatch(/left:\s*var\(--playback-peak-position\)/);
    expect(peakMarker).toMatch(/border-bottom:\s*6px\s+solid\s+var\(--color-warning\)/);
    expect(playbackWebkitThumb).toMatch(/width:\s*6px/);
    expect(playbackWebkitThumb).toMatch(/border-radius:\s*3px/);
    expect(playbackMozThumb).toMatch(/width:\s*4px/);
    expect(playbackMozThumb).toMatch(/border-radius:\s*3px/);
  });
  test("gives compact controls a 24px minimum target", () => {
    // WCAG 2.5.8. Measured before this: camera presets ~22px, the brand
    // control 18px, footer links 16-17px.
    expect(css).toContain(".brand-button {\n  min-height: 24px;");
    expect(css).toContain(".viewer-view-presets button {\n  min-height: 24px;");
    expect(css).toContain(".status-link {\n  min-height: 24px;");
    expect(css).toContain(".status-attribution {\n  min-height: 24px;");
  });

  test("styles the load row summary as a real button rather than a clickable row", () => {
    expect(css).toContain(".editable-summary-trigger {");
    expect(css).not.toContain(".editable-item.clickable");
  });

  test("keeps the status strip from overprinting itself when it runs out of room", () => {
    // The tab controls are fixed-size and .status-groups is the sibling built to give
    // way (min-width: 0, overflow: hidden, white-space: nowrap). With the default
    // flex-shrink the tabs were squeezed below their 121px min-content instead and the
    // "Logs" pill painted over the status text and then over the Ko-fi link.
    expect(cssRule(".status-tabs")).toMatch(/flex-shrink:\s*0/);
    expect(cssRule(".status-primary")).toMatch(/min-width:\s*0/);
    expect(cssRule(".status-primary")).toMatch(/overflow:\s*hidden/);
    expect(cssRule(".status-groups")).toMatch(/overflow:\s*hidden/);

    // Below the narrow tier the word no longer fits beside the controls. The dot still
    // carries the state, so the word is clipped rather than removed — same treatment the
    // collapsed rail gives its step labels — and stays in the accessibility tree.
    const narrowTier = css.match(/@media \(max-width: 640px\) \{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? "";
    const narrowRule = (selector: string) =>
      narrowTier.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*\\{(?<body>[^}]*)\\}`))
        ?.groups?.body ?? "";

    expect(narrowRule(".status-state-label")).toMatch(/clip:\s*rect\(0, 0, 0, 0\)/);
    expect(narrowRule(".coffee-label")).toMatch(/display:\s*none/);
    // display: none would drop the state from the accessibility tree entirely.
    expect(narrowRule(".status-state-label")).not.toMatch(/display:\s*none/);
    // The base rule keeps the Ko-fi wordmark laid out at full width.
    expect(cssRule(".coffee-label")).toMatch(/display:\s*inline-flex/);
  });

  test("covers the gap between the viewer mounting and the scene drawing", () => {
    // CadViewer's own render returns in tens of milliseconds; the seconds-long blank on a
    // cold boot is the Three scene building inside <Canvas>. The overlay is a DOM sibling
    // of the canvas so it paints in that first fast render.
    expect(cadViewer).toContain("<strong>Preparing the 3D view…</strong>");
    expect(cadViewer).toContain('<SceneFirstFrameSignal onPainted={handleScenePainted} />');
    // addAfterEffect fires AFTER a rendered frame; useFrame runs before one, so it would
    // clear the overlay a frame early. Matched against the function's own body.
    const signalBody = cadViewer.match(/function SceneFirstFrameSignal\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(signalBody).toContain("addAfterEffect(");
    expect(signalBody).not.toContain("useFrame(");
    // Held back so a warm mount never flashes it, and bounded so a scene that never draws
    // leaves a bare viewport rather than a spinner promising a model that is not coming.
    expect(cadViewer).toMatch(/SCENE_LOADING_REVEAL_MS = \d+/);
    expect(cadViewer).toMatch(/SCENE_LOADING_TIMEOUT_MS = \d+/);
    expect(cadViewer).toContain('setSceneLoadingPhase("expired")');
    // Never stacked on top of the model-import overlay.
    expect(cadViewer).toContain('{!props.importingModelFilename && !scenePainted && sceneLoadingPhase === "visible" ? (');
  });

  test("gives the viewer's loading fallback the same treatment as the import overlay", () => {
    // .viewer-loading had no rule at all, so the Suspense fallback rendered unstyled text
    // in the corner of a black box — the first thing a returning user sees on a cold boot.
    const loading = cssRule(".viewer-loading");

    expect(loading).toMatch(/display:\s*grid/);
    expect(loading).toMatch(/place-items:\s*center/);
    expect(appSource).toContain('className="viewer-shell viewer-loading"');
    expect(appSource).toContain('<span className="viewer-import-spinner" aria-hidden="true" />');
    expect(appSource).toContain('<strong>Preparing the 3D view…</strong>');
    // The spinner it reuses already opts out of animation under reduced motion.
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.viewer-import-spinner \{\s*animation:\s*none/);
  });

  test("makes accent-filled buttons legible when focused and when disabled", () => {
    // The global ring is --color-accent one pixel outside the element, which on an
    // accent-FILLED button is the fill colour against itself — it read as the button
    // growing rather than as focus.
    const primaryFocus = cssRule(".primary:focus-visible");
    expect(primaryFocus).toMatch(/outline-color:\s*var\(--color-text\)/);
    expect(primaryFocus).toMatch(/outline-offset:\s*2px/);

    // A dimmed accent still dominates a panel footer and reads as "loading" rather than
    // "unavailable", so a disabled primary drops to the neutral surface instead.
    const primaryDisabled = cssRule(".primary:disabled");
    expect(primaryDisabled).toMatch(/background:\s*var\(--color-surface-2\)/);
    expect(primaryDisabled).toMatch(/color:\s*var\(--color-text-muted\)/);
    expect(primaryDisabled).toMatch(/opacity:\s*1/);
    // The generic rule stays, for every button that is not accent-filled.
    expect(cssRule("button:disabled")).toMatch(/opacity:\s*0\.45/);
  });

  test("keeps the light theme from inheriting dark-theme ink", () => {
    // body resolves var(--color-text) in :root scope — against the DARK value — and that
    // computed color inherits straight past .theme-light. .app-shell must re-declare it in
    // the themed scope or every descendant without its own color paints dark ink on light.
    expect(cssRule(".app-shell")).toMatch(/color:\s*var\(--color-text\)/);
  });

  test("anchors small text to the scale instead of the browser default", () => {
    // There is zero relative font sizing in this stylesheet, which made the UA's
    // `small { font-size: smaller }` provably the only source of the app's sub-11px text:
    // the legend labels at 9.58px and the colour-scale range line at 10.83px — a measured
    // value rendering smaller than its own caption.
    expect(tokens).toMatch(/\bsmall \{[^}]*font-size:\s*var\(--fs-xs\)/);
    // Unstyled headings otherwise render at the UA's bold 700 and em-based sizes, which is
    // where the off-token weights came from.
    expect(tokens).toMatch(/h1, h2, h3, h4, h5, h6 \{[^}]*font-weight:\s*var\(--fw-medium\)/);
    expect(tokens).toMatch(/h1, h2, h3, h4, h5, h6 \{[^}]*font-size:\s*inherit/);
    // `strong` is deliberately NOT reset: 17 rules already set --fw-medium on it, which is
    // evidence the codebase treats bold-vs-medium as a per-component choice.
    expect(tokens).not.toMatch(/\bstrong,?\s*b?\s*\{[^}]*font-weight/);
  });

  test("gives result figures the one display level in the app", () => {
    // --fs-xl was defined and used zero times, so the largest type in the workspace was
    // 16px and the number a user ran the solve for rendered at the same size and weight as
    // the solver-runner string beside it.
    const headline = cssRule(".result-headline-item strong");
    expect(headline).toMatch(/font-size:\s*var\(--fs-xl\)/);
    expect(headline).toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(headline).toMatch(/overflow-wrap:\s*anywhere/);

    // Two-up, and one column in the narrow tier: at ~130px a value splits from its unit.
    expect(cssRule(".result-headline")).toMatch(/grid-template-columns:\s*repeat\(2/);
    const narrowTier = css.match(/@media \(max-width: 640px\) \{(?<body>[\s\S]*?)\n\}/)?.groups?.body ?? "";
    expect(narrowTier).toMatch(/\.result-headline \{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
  });

  test("keeps a component tier between the primitives and the components", () => {
    // tokens.css had primitives and app.css had components with nothing in between, so
    // every rule re-derived its own box and the UI could express value but not rank.
    for (const name of ["--sp-15", "--sp-25", "--control-h-sm", "--control-h-md", "--control-h-lg",
      "--card-pad", "--card-pad-tight", "--card-radius", "--gap-block", "--gap-section",
      "--fw-semibold", "--lh-snug"]) {
      expect(tokens, `missing component token ${name}`).toMatch(new RegExp(`${name}:\\s*[^;]+;`));
    }

    // Spacing is expressed through the scale, not re-typed. A handful of orphan values
    // (5/7/9/11px and friends) are deliberately left alone rather than rounded onto it.
    const spacingLiterals = [...css.matchAll(/^\s*(?:padding|margin|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left))?:\s*([^;]+);/gm)]
      .flatMap((match) => (match[1] ?? "").split(/\s+/))
      .filter((value) => /^(4|6|8|10|12|16|24|32)px$/.test(value));
    expect(spacingLiterals).toEqual([]);

    expect(css).not.toMatch(/font-weight:\s*600;/);
    expect(css).not.toMatch(/line-height:\s*1\.(35|45);/);

    // Zero-use tokens are gone; --radius-pill is NOT dead (one real consumer) and is 10px,
    // so the 999px pills must keep their literal or they visibly square off.
    expect(tokens).not.toContain("--sp-7:");
    expect(tokens).not.toContain("--log-drawer-h:");
    expect(css).toMatch(/border-radius:\s*999px/);
  });

  test("keeps one eyebrow recipe and one card recipe rather than a copy per component", () => {
    // The mono/mini/tracked/uppercase eyebrow was retyped across twelve rules. It lives in
    // one grouped rule now; each component still owns its own colour and layout, and every
    // class name is unchanged because the assertions here look selectors up literally.
    const eyebrowCopies = [...css.matchAll(/letter-spacing:\s*var\(--ls-eyebrow\);/g)].length;
    expect(eyebrowCopies).toBeLessThanOrEqual(4);

    // .section-title used to be declared twice: once beside .panel-eyebrow and again in
    // .editable-list h3, which re-declared all five properties at equal specificity later
    // in the file, so the first was dead.
    expect(css).not.toMatch(/\.panel-eyebrow,\n\.section-title \{/);

    // Card interiors resolve through the shared tokens.
    for (const selector of [".help-note", ".result-probe-list", ".result-scale-controls",
      ".placement-chip", ".load-combination-row", ".shortcut-toggle"]) {
      expect(cssRule(selector), selector).toMatch(/padding:\s*var\(--card-pad\)/);
    }
    // --card-radius resolves to the primitive rather than repeating its value.
    expect(tokens).toMatch(/--card-radius:\s*var\(--radius-md\)/);
  });

  test("separates the section boundary from the block gap enough to group", () => {
    // 22px above a 14px block gap is a 1.57x ratio — too close for space to group anything,
    // which is why every section also needed a rule under it. --gap-section makes it 2.0x.
    // Identified by its border, not by name: cssRule() substring-matches, so
    // ".section-title" resolves to `.result-probe-list-header .section-title` (margin: 0),
    // and there is a second standalone rule carrying the shared type treatment.
    const sectionBoundary = css.match(/^\.section-title \{[^}]*border-bottom[^}]*\}/m)?.[0] ?? "";
    expect(sectionBoundary).toMatch(/margin:\s*var\(--gap-section\)/);
    expect(tokens).toMatch(/--gap-section:\s*28px/);
    // Not achieved by shrinking the block gap: .field carries it and sits on every form
    // field on all seven steps, so retuning it is a global reflow rather than a panel change.
    expect(cssRule(".field")).toMatch(/margin:\s*0 0 14px/);

    // .info-row is the app's most-repeated data atom (64 instances). At 8px padding plus a
    // 19.5px line plus a rule it was ~36.5px per row while the chrome around it was
    // tool-tight. The font size is deliberately untouched.
    const infoRow = cssRule(".info-row");
    expect(infoRow).toMatch(/padding:\s*var\(--sp-1\) 0/);
    expect(infoRow).toMatch(/line-height:\s*var\(--lh-tight\)/);
    expect(infoRow).not.toMatch(/font-size/);
  });

  test("resolves every custom property it references", () => {
    // An undefined custom property invalidates its whole declaration at computed-value
    // time, so `padding: var(--typo) 6px` silently becomes `padding: 0` — a class of bug
    // the literal-declaration assertions above are structurally blind to.
    // Only properties written by component code at runtime may go unresolved here.
    const runtimeAssigned = new Set(["--analysis-legend-scale", "--playback-peak-position"]);
    const names = (source: string, pattern: RegExp) =>
      [...source.matchAll(pattern)].flatMap((match) => (match[1] ? [match[1]] : []));
    const declared = new Set([
      ...names(css, /(--[A-Za-z0-9-]+)\s*:/g),
      ...names(tokens, /(--[A-Za-z0-9-]+)\s*:/g),
    ]);
    const unresolved = [...new Set(names(css, /var\(\s*(--[A-Za-z0-9-]+)/g))]
      .filter((name) => !declared.has(name) && !runtimeAssigned.has(name))
      .sort();

    expect(unresolved).toEqual([]);
  });
});
