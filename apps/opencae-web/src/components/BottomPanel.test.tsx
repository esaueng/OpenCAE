import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { BottomPanel, KeyboardShortcutGuide, WORKSPACE_SHORTCUT_GUIDE } from "./BottomPanel";

describe("BottomPanel", () => {
  test("keeps the GitHub link in the bottom status area", () => {
    const html = renderToStaticMarkup(
      <BottomPanel
        status="Results ready"
        logs={["Ready"]}
        projectName="Cantilever Demo"
        studyName="Static Stress"
        meshStatus="Ready"
        solverStatus="Complete"
        backendStatus="local"
      />
    );

    expect(html).toContain('class="status-links"');
    expect(html).toContain('class="status-link"');
    expect(html).toContain('href="https://form.esauengineering.com/opencae-feedback"');
    expect(html).toContain('href="https://ko-fi.com/petergustafson"');
    expect(html).toContain('href="https://github.com/esaueng/OpenCAE"');
    expect(html).toContain(">feedback</a>");
    expect(html).toContain("Buy me a coffee</a>");
    expect(html).toContain(">github</a>");
    expect(html.indexOf("Results ready")).toBeLessThan(html.indexOf("local"));
    expect(html.indexOf("local")).toBeLessThan(html.indexOf("<b>project</b>"));
    expect(html.indexOf("Buy me a coffee</a>")).toBeGreaterThan(html.indexOf("<b>solver</b>"));
    expect(html.indexOf("Buy me a coffee</a>")).toBeLessThan(html.indexOf(">feedback</a>"));
    expect(html.indexOf("Buy me a coffee</a>")).toBeLessThan(html.indexOf(">github</a>"));
    expect(html.indexOf(">github</a>")).toBeGreaterThan(html.indexOf("<b>solver</b>"));
  });

  test("shows cloud backend status when Cloud FEA is selected", () => {
    const html = renderToStaticMarkup(
      <BottomPanel
        status="Ready"
        logs={["Ready"]}
        projectName="Cantilever Demo"
        studyName="Static Stress"
        meshStatus="Ready"
        solverStatus="Idle"
        backendStatus="cloud"
      />
    );

    expect(html).toContain('class="backend-pill"');
    expect(html).toContain(">cloud</span>");
  });

  test("defines the active workspace shortcuts shown in the tips drawer", () => {
    expect(WORKSPACE_SHORTCUT_GUIDE).toEqual([
      { keys: ["N"], label: "Next workflow step" },
      { keys: ["B"], label: "Previous workflow step" },
      { keys: ["H"], label: "Fit view / home view" },
      { keys: ["Ctrl/Cmd", "S"], label: "Save project" },
      { keys: ["Ctrl/Cmd", "Z"], label: "Undo" },
      { keys: ["Shift", "Ctrl/Cmd", "Z"], label: "Redo" }
    ]);
  });

  test("renders a keyboard shortcuts guide for the tips drawer", () => {
    const html = renderToStaticMarkup(<KeyboardShortcutGuide />);

    expect(html).toContain('class="shortcut-guide"');
    expect(html).toContain("Keyboard shortcuts");
    expect(html).toContain("<kbd>N</kbd>");
    expect(html).toContain("Next workflow step");
    expect(html).toContain("<kbd>Ctrl/Cmd</kbd>");
    expect(html).toContain("Save project");
  });
});
