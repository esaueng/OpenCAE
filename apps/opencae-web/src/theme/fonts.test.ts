import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const fonts = readFileSync(resolve(__dirname, "fonts.css"), "utf8");
const tokens = readFileSync(resolve(__dirname, "tokens.css"), "utf8");
const faces = fonts.match(/@font-face\s*\{[^}]*\}/g) ?? [];

describe("app typeface", () => {
  test("loads the family --font-ui declares, in every weight the stylesheet uses", () => {
    expect(tokens).toMatch(/--font-ui: 'IBM Plex Sans'/);
    for (const weight of ["400", "500", "600"]) {
      const face = faces.find((block) => block.includes(`font-weight: ${weight};`) && block.includes(`ibm-plex-sans-latin-${weight}-normal.woff2`));
      expect(face, `latin face for weight ${weight}`).toBeDefined();
    }
  });

  test("Greek faces are range-gated so they only download when a Greek glyph renders", () => {
    const greek = faces.filter((block) => block.includes("-greek-"));
    expect(greek).toHaveLength(3);
    for (const face of greek) expect(face).toMatch(/unicode-range: U\+0370-0377,/);
  });

  test("every face swaps instead of blocking text, and none is a TTF", () => {
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) {
      expect(face).toContain("font-display: swap;");
      expect(face).toMatch(/format\("woff2"\)/);
    }
  });
});
