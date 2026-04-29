import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { StartScreen } from "./StartScreen";

describe("StartScreen", () => {
  test("links the Esau Engineering credit to the company website", () => {
    const html = renderToStaticMarkup(
      <StartScreen onLoadSample={vi.fn()} onCreateProject={vi.fn()} onOpenProject={vi.fn()} />
    );

    expect(html).toContain('href="https://esauengineering.com/"');
    expect(html).toContain("Built by Esau Engineering");
    expect(html).toContain('href="https://github.com/esaueng/OpenCAE"');
    expect(html).toContain("Runs locally");
    expect(html).not.toContain("v0.1.0-mvp");
    expect(html).not.toContain("local mode");
  });

  test("renders sample model and analysis selectors", () => {
    const html = renderToStaticMarkup(
      <StartScreen onLoadSample={vi.fn()} onCreateProject={vi.fn()} onOpenProject={vi.fn()} />
    );

    expect(html).toContain("Sample model");
    expect(html).toContain("Bracket");
    expect(html).toContain("Beam");
    expect(html).toContain("Cantilever");
    expect(html).toContain("Analysis type");
    expect(html).toContain("Static");
    expect(html).toContain("Dynamic");
  });
});
