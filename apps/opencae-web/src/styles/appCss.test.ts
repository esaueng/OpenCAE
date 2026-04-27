import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const css = readFileSync(resolve(__dirname, "app.css"), "utf8");

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
});
