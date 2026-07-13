import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const css = readFileSync(resolve(__dirname, "app.css"), "utf8");
const tokens = readFileSync(resolve(__dirname, "../theme/tokens.css"), "utf8");
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
  test("does not ship the removed viewer reset HUD button styles", () => {
    expect(css).not.toContain(".viewer-hud");
    expect(css).not.toContain(".viewer-reset");
  });

  test("lightens the analysis legend in light mode", () => {
    expect(css).toMatch(/\.theme-light\s+\.analysis-legend\s*\{[\s\S]*?background:\s*rgba\(255,\s*255,\s*255,\s*0\.88\)/);
    expect(css).toMatch(/\.theme-light\s+\.analysis-legend\s*\{[\s\S]*?color:\s*var\(--color-text\)/);
    expect(css).toMatch(/\.theme-light\s+\.analysis-legend\s+\.legend-scale\s*\{[\s\S]*?border-color:\s*rgba\(82,\s*103,\s*130,\s*0\.24\)/);
  });

  test("makes the analysis legend larger by default with a top-right resize handle", () => {
    const analysisLegend = cssRule(".analysis-legend");
    const resizeHandle = cssRule(".analysis-legend-resize");
    const resizeHandleAfter = cssRule(".analysis-legend-resize::after");

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
    expect(resizeHandle).toMatch(/top:\s*0/);
    expect(resizeHandle).toMatch(/right:\s*0/);
    expect(resizeHandle).toMatch(/cursor:\s*nesw-resize/);
    expect(resizeHandleAfter).toMatch(/border-top:\s*2px\s+solid/);
    expect(resizeHandleAfter).toMatch(/border-right:\s*2px\s+solid/);
  });

  test("scales result legend visual elements with resized content", () => {
    expect(cssRule(".legend-scale")).toMatch(/height:\s*calc\(10px\s*\*\s*var\(--analysis-legend-scale,\s*1\)\)/);
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
});
