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
  test("lightens the reset view button in light mode", () => {
    expect(css).toMatch(/\.theme-light\s+\.viewer-reset\s*\{[\s\S]*?background:\s*rgba\(255,\s*255,\s*255,\s*0\.9\)/);
    expect(css).toMatch(/\.theme-light\s+\.viewer-reset\s*\{[\s\S]*?border-color:\s*rgba\(82,\s*103,\s*130,\s*0\.24\)/);
  });

  test("lightens the analysis legend in light mode", () => {
    expect(css).toMatch(/\.theme-light\s+\.analysis-legend\s*\{[\s\S]*?background:\s*rgba\(255,\s*255,\s*255,\s*0\.88\)/);
    expect(css).toMatch(/\.theme-light\s+\.analysis-legend\s*\{[\s\S]*?color:\s*var\(--color-text\)/);
    expect(css).toMatch(/\.theme-light\s+\.analysis-legend\s+\.legend-scale\s*\{[\s\S]*?border-color:\s*rgba\(82,\s*103,\s*130,\s*0\.24\)/);
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

  test("only underlines start screen footer links on hover", () => {
    const startFooterLinks = cssRule(".start-footer a");
    const startFooterLinkHover = cssRule(".start-footer a:hover,\n.start-footer a:focus-visible");

    expect(startFooterLinks).toMatch(/text-decoration:\s*none/);
    expect(startFooterLinkHover).toMatch(/text-decoration:\s*underline/);
  });
});
