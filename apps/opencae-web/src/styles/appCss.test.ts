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
    expect(analysisLegend).toMatch(/min-height:\s*176px/);
    expect(analysisLegend).toMatch(/max-width:\s*calc\(100%\s*-\s*24px\)/);
    expect(analysisLegend).toMatch(/max-height:\s*calc\(100%\s*-\s*24px\)/);
    expect(analysisLegend).toMatch(/overflow:\s*auto/);
    expect(analysisLegend).toMatch(/resize:\s*none/);
    expect(analysisLegend).toMatch(/pointer-events:\s*auto/);
    expect(analysisLegend).toMatch(/align-content:\s*start/);
    expect(analysisLegend).toMatch(/font-size:\s*calc\(var\(--fs-mini\)\s*\*\s*var\(--analysis-legend-scale,\s*1\)\)/);
    expect(analysisLegend).toMatch(/gap:\s*calc\(6px\s*\*\s*var\(--analysis-legend-scale,\s*1\)\)\s+calc\(12px\s*\*\s*var\(--analysis-legend-scale,\s*1\)\)/);
    expect(analysisLegend).toMatch(/padding:\s*calc\(14px\s*\*\s*var\(--analysis-legend-scale,\s*1\)\)\s+calc\(16px\s*\*\s*var\(--analysis-legend-scale,\s*1\)\)\s+calc\(8px\s*\*\s*var\(--analysis-legend-scale,\s*1\)\)/);
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

  test("places the start screen logo on the grid rhythm above center", () => {
    const startBrand = cssRule(".start-brand");

    expect(startBrand).toMatch(/position:\s*absolute/);
    expect(startBrand).toMatch(/top:\s*calc\(50%\s*-\s*126px\)/);
    expect(startBrand).toMatch(/transform:\s*translate\(-50%,\s*-28px\)/);
  });

  test("uses the start screen background for the required simulation type screen", () => {
    const simulationTypeScreen = cssRule(".simulation-type-screen");
    const simulationTypeGrid = cssRule(".simulation-type-screen::before");

    expect(simulationTypeScreen).toMatch(/radial-gradient\(ellipse\s+80%\s+50%\s+at\s+50%\s+0%/);
    expect(simulationTypeGrid).toMatch(/background-size:\s*42px\s+42px/);
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

  test("centers and animates the Ko-fi topbar action", () => {
    const topbar = cssRule(".topbar");
    const donateAction = cssRule(".donate-action");
    const donateIntro = cssRule(".donate-action-intro");

    expect(topbar).toMatch(/position:\s*relative/);
    expect(donateAction).toMatch(/position:\s*absolute/);
    expect(donateAction).toMatch(/left:\s*50%/);
    expect(donateAction).toMatch(/transform:\s*translateX\(-50%\)/);
    expect(donateIntro).toMatch(/animation:\s*donate-pop-in/);
    expect(css).toContain("@keyframes donate-pop-in");
    expect(css).toContain("@keyframes donate-shimmer");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });

  test("only underlines start screen footer links on hover", () => {
    const startFooterLinks = cssRule(".start-footer a");
    const startFooterLinkHover = cssRule(".start-footer a:hover,\n.start-footer a:focus-visible");

    expect(startFooterLinks).toMatch(/text-decoration:\s*none/);
    expect(startFooterLinkHover).toMatch(/text-decoration:\s*underline/);
  });

  test("hides native focus outlines on range sliders", () => {
    const rangeInput = cssRule(".range-field input[type=\"range\"]");
    const rangeFocus = cssRule(".range-field input[type=\"range\"]:focus,\n.range-field input[type=\"range\"]:focus-visible");

    expect(rangeInput).toMatch(/border:\s*none/);
    expect(rangeInput).toMatch(/padding:\s*0/);
    expect(rangeFocus).toMatch(/outline:\s*none/);
    expect(rangeFocus).toMatch(/box-shadow:\s*none/);
  });

  test("styles playback time as a passive playhead instead of a draggable slider", () => {
    const playbackRange = cssRule(".range-field input.playback-time-range");
    const playbackWebkitThumb = cssRule(".range-field input.playback-time-range::-webkit-slider-thumb");
    const playbackMozThumb = cssRule(".range-field input.playback-time-range::-moz-range-thumb");

    expect(playbackRange).toMatch(/cursor:\s*default/);
    expect(playbackWebkitThumb).toMatch(/width:\s*6px/);
    expect(playbackWebkitThumb).toMatch(/border-radius:\s*3px/);
    expect(playbackMozThumb).toMatch(/width:\s*4px/);
    expect(playbackMozThumb).toMatch(/border-radius:\s*3px/);
  });
});
