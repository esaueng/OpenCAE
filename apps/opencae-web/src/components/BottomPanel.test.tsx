import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { BottomPanel, KeyboardShortcutGuide, WORKSPACE_SHORTCUT_GUIDE, resolveLogClearIntent } from "./BottomPanel";

const bottomPanelSource = readFileSync(resolve(__dirname, "BottomPanel.tsx"), "utf8");
const workspaceSource = readFileSync(resolve(__dirname, "../WorkspaceApp.tsx"), "utf8");

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
        onClearLogs={() => undefined}
      />
    );

    expect(html).toContain('class="status-links"');
    expect(html).toContain('class="status-link"');
    expect(html).toContain('href="https://form.esauengineering.com/opencae-feedback"');
    expect(html).toContain('href="https://ko-fi.com/petergn"');
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
        onClearLogs={() => undefined}
      />
    );

    expect(html).toContain('class="backend-pill"');
    expect(html).toContain(">cloud</span>");
  });

  test("shows Cloud FEA errors instead of collapsing them to ready", () => {
    const html = renderToStaticMarkup(
      <BottomPanel
        status="Cloud FEA run creation failed: POST /api/cloud-fea/runs failed with HTTP 404."
        logs={["Cloud FEA run creation failed: POST /api/cloud-fea/runs failed with HTTP 404."]}
        projectName="Cantilever Demo"
        studyName="Static Stress"
        meshStatus="Ready"
        solverStatus="Idle"
        backendStatus="cloud"
        onClearLogs={() => undefined}
      />
    );

    expect(html).toContain(">Cloud FEA error</span>");
    expect(html).not.toContain('class="status-state ready"');
  });

  test("defines a copy logs control inside the logs drawer", () => {
    expect(bottomPanelSource).toContain('className="log-copy-button"');
    expect(bottomPanelSource).toContain("Copy logs");
    expect(bottomPanelSource).toContain("navigator.clipboard.writeText");
  });

  test("requires two clicks before clearing run logs", () => {
    expect(resolveLogClearIntent(0, false)).toBe("confirm");
    expect(resolveLogClearIntent(1, false)).toBe("confirm");
    expect(resolveLogClearIntent(2, false)).toBe("clear");
    expect(resolveLogClearIntent(0, true)).toBe("clear");
    expect(resolveLogClearIntent(1, true)).toBe("clear");
  });

  test("defines a double-click clear logs control wired to workspace logs", () => {
    expect(bottomPanelSource).toContain('className="log-clear-button"');
    expect(bottomPanelSource).toContain("Clear logs");
    expect(bottomPanelSource).toContain("Double-click to clear");
    expect(bottomPanelSource).toContain("onClearLogs");
    expect(workspaceSource).toContain("onClearLogs={clearLogs}");
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
