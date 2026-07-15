import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RecentProjectsSection, StartScreen } from "./StartScreen";
import { advanceOfflineReadiness, resetOfflineReadinessForTests } from "../lib/offlineStatus";

afterEach(() => {
  resetOfflineReadinessForTests();
});

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

  test("claims nothing about offline readiness before the service worker reports it", () => {
    const html = renderToStaticMarkup(
      <StartScreen onLoadSample={vi.fn()} onCreateProject={vi.fn()} onOpenProject={vi.fn()} />
    );

    expect(html).toContain("Runs locally");
    expect(html).not.toContain("Offline-ready");
    expect(html).not.toContain("Preparing offline assets");
  });

  test("shows the caching progress, then Offline-ready, as text in the footer", () => {
    advanceOfflineReadiness("preparing");
    const preparing = renderToStaticMarkup(
      <StartScreen onLoadSample={vi.fn()} onCreateProject={vi.fn()} onOpenProject={vi.fn()} />
    );
    expect(preparing).toContain("Preparing offline assets…");
    expect(preparing).not.toContain("Offline-ready");

    advanceOfflineReadiness("ready");
    const ready = renderToStaticMarkup(
      <StartScreen onLoadSample={vi.fn()} onCreateProject={vi.fn()} onOpenProject={vi.fn()} />
    );
    expect(ready).toContain("Offline-ready");
    expect(ready).not.toContain("Preparing offline assets");
    // A11y: the state is conveyed as text (role=status), never color-only.
    expect(ready).toContain('role="status"');
  });

  test("says nothing misleading when the service worker is unsupported or failed", () => {
    advanceOfflineReadiness("unsupported");
    const html = renderToStaticMarkup(
      <StartScreen onLoadSample={vi.fn()} onCreateProject={vi.fn()} onOpenProject={vi.fn()} />
    );
    expect(html).toContain("Runs locally");
    expect(html).not.toContain("Offline");
  });

  test("keeps sample choices inside the load sample submenu", () => {
    const html = renderToStaticMarkup(
      <StartScreen onLoadSample={vi.fn()} onCreateProject={vi.fn()} onOpenProject={vi.fn()} />
    );

    expect(html).toContain("Load sample project");
    expect(html).toContain('aria-label="Open sample menu"');
    expect(html).not.toContain("Sample model");
    expect(html).not.toContain('aria-label="Sample setup"');
    expect(html).not.toContain("Bracket Demo");
    expect(html).not.toContain("Beam Demo");
    expect(html).not.toContain("Cantilever Demo");
  });

  test("renders recent-project open, remove, and clear actions", () => {
    const html = renderToStaticMarkup(
      <RecentProjectsSection
        entries={[{
          id: "recent-1",
          filename: "wing.opencae.json",
          projectName: "Wing Rev B",
          lastOpenedAt: 1,
          handle: { name: "wing.opencae.json", getFile: vi.fn() }
        }]}
        busyId={null}
        onOpen={vi.fn()}
        onRemove={vi.fn()}
        onClear={vi.fn()}
      />
    );

    expect(html).toContain('aria-label="Recent Projects"');
    expect(html).toContain("Wing Rev B");
    expect(html).toContain("wing.opencae.json");
    expect(html).toContain("Open");
    expect(html).toContain("Remove");
    expect(html).toContain("Clear List");
  });
});

describe("SampleProjectMenu", () => {
  test("renders visual sample choices and analysis controls in the submenu", async () => {
    const { SampleProjectMenu } = await import("./StartScreen");
    const html = renderToStaticMarkup(
      <SampleProjectMenu
        selectedSample="bracket"
        selectedAnalysisType="static_stress"
        onBack={vi.fn()}
        onLoadSample={vi.fn()}
        onSelectAnalysisType={vi.fn()}
        onSelectSample={vi.fn()}
      />
    );

    expect(html).toContain("Sample model");
    expect(html).toContain("Analysis type");
    expect(html).toContain('aria-label="Sample setup"');
    expect(html).toContain("Bracket Demo");
    expect(html).toContain("Beam Demo");
    expect(html).toContain("Cantilever Demo");
    expect(html).toContain("Static");
    expect(html).toContain("Dynamic");
    expect(html).toContain("Modal");
    expect(html).toContain("Thermal");
    expect(html).toContain("sample-analysis-type-grid");
  });
});
