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

  test("anchors the start screen logo to the grid center", () => {
    const startBrand = cssRule(".start-brand");

    expect(startBrand).toMatch(/position:\s*absolute/);
    expect(startBrand).toMatch(/top:\s*50%/);
    expect(startBrand).toMatch(/transform:\s*translate\(-50%,\s*-28px\)/);
  });
});
