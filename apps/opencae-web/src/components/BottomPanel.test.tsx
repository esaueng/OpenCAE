import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  BottomPanel,
  COFFEE_ANIMATION_REPLAY_DELAY_MS,
  KeyboardShortcutGuide,
  WORKSPACE_SHORTCUT_GUIDE,
  coffeeAnimationReplayDelayMs,
  resolveLogClearIntent
} from "./BottomPanel";

const bottomPanelSource = readFileSync(resolve(__dirname, "BottomPanel.tsx"), "utf8");
const workspaceSource = readFileSync(resolve(__dirname, "../WorkspaceApp.tsx"), "utf8");

function textContent(html: string) {
  let text = "";
  let insideTag = false;
  for (const char of html) {
    if (char === "<") {
      insideTag = true;
      continue;
    }
    if (char === ">") {
      insideTag = false;
      continue;
    }
    if (!insideTag) text += char;
  }
  return text;
}

describe("BottomPanel", () => {
  test("keeps the GitHub link in the bottom status area", () => {
    const html = renderToStaticMarkup(
      <BottomPanel
        status="Results ready"
        logs={[{ message: "Ready", at: 1714000000000 }]}
        projectName="Cantilever Demo"
        studyName="Static Stress"
        meshStatus="Ready"
        solverStatus="Complete"
        backendStatus="core"
        onClearLogs={() => undefined}
      />
    );

    expect(html).toContain('class="status-links"');
    expect(html).toContain('class="status-link"');
    expect(html).toContain('href="https://form.esauengineering.com/opencae-feedback"');
    expect(html).toContain('href="https://ko-fi.com/petergn"');
    expect(html).toContain('href="https://github.com/esaueng/OpenCAE"');
    expect(html).toContain(">feedback</a>");
    expect(textContent(html)).toContain("Buy me a coffee");
    expect(html).toContain(">github</a>");
    expect(html.indexOf("Results ready")).toBeLessThan(html.indexOf("core"));
    expect(html.indexOf("core")).toBeLessThan(html.indexOf("<b>project</b>"));
    expect(html.indexOf('href="https://ko-fi.com/petergn"')).toBeGreaterThan(html.indexOf("<b>solver</b>"));
    expect(html.indexOf('href="https://ko-fi.com/petergn"')).toBeLessThan(html.indexOf('href="https://form.esauengineering.com/opencae-feedback"'));
    expect(html.indexOf('href="https://ko-fi.com/petergn"')).toBeLessThan(html.indexOf('href="https://github.com/esaueng/OpenCAE"'));
    expect(html.indexOf(">github</a>")).toBeGreaterThan(html.indexOf("<b>solver</b>"));
  });

  test("renders decorative coffee animation elements and wave text without changing link copy", () => {
    const html = renderToStaticMarkup(
      <BottomPanel
        status="Results ready"
        logs={[{ message: "Ready", at: 1714000000000 }]}
        projectName="Cantilever Demo"
        studyName="Static Stress"
        meshStatus="Ready"
        solverStatus="Complete"
        backendStatus="core"
        onClearLogs={() => undefined}
      />
    );

    expect(html).toContain('class="coffee-mark"');
    expect(html).toContain('class="coffee-steam coffee-steam-one"');
    expect(html).toContain('class="coffee-steam coffee-steam-two"');
    expect(html).toContain('class="coffee-sparkle"');
    expect(html).toContain('class="coffee-label"');
    expect(html).toContain('class="coffee-letter"');
    expect(html).toContain("--coffee-letter-index:0");
    expect(html).toContain("--coffee-letter-index:14");
    expect(textContent(html)).toContain("Buy me a coffee");
  });

  test("wires hover to play the coffee animation once", () => {
    expect(bottomPanelSource).toContain("function runCoffeeAnimation()");
    expect(bottomPanelSource).toContain("onMouseEnter={runCoffeeAnimation}");
    expect(bottomPanelSource).toContain("window.clearTimeout(animationTimeoutRef.current)");
  });

  test("bounds the randomized coffee animation replay delay", () => {
    expect(COFFEE_ANIMATION_REPLAY_DELAY_MS).toEqual({ min: 18000, max: 45000 });
    expect(coffeeAnimationReplayDelayMs(0)).toBe(18000);
    expect(coffeeAnimationReplayDelayMs(0.5)).toBe(31500);
    expect(coffeeAnimationReplayDelayMs(1)).toBe(45000);
    expect(coffeeAnimationReplayDelayMs(-1)).toBe(18000);
    expect(coffeeAnimationReplayDelayMs(2)).toBe(45000);
  });

  test("shows core backend status when OpenCAE Core is selected", () => {
    const html = renderToStaticMarkup(
      <BottomPanel
        status="Ready"
        logs={[{ message: "Ready", at: 1714000000000 }]}
        projectName="Cantilever Demo"
        studyName="Static Stress"
        meshStatus="Ready"
        solverStatus="Idle"
        backendStatus="core"
        onClearLogs={() => undefined}
      />
    );

    expect(html).toContain('class="backend-pill"');
    expect(html).toContain(">core</span>");
  });

  test("shows OpenCAE Core errors instead of collapsing them to ready", () => {
    const html = renderToStaticMarkup(
      <BottomPanel
        status="OpenCAE Core solve failed: singular matrix."
        logs={[{ message: "OpenCAE Core solve failed: singular matrix.", at: 1714000000000 }]}
        projectName="Cantilever Demo"
        studyName="Static Stress"
        meshStatus="Ready"
        solverStatus="Idle"
        backendStatus="core"
        onClearLogs={() => undefined}
      />
    );

    expect(html).toContain(">OpenCAE Core error</span>");
    expect(html).not.toContain('class="status-state ready"');
  });

  test("defines a copy logs control inside the logs drawer", () => {
    expect(bottomPanelSource).toContain('className="log-copy-button"');
    expect(bottomPanelSource).toContain("Copy logs");
    expect(bottomPanelSource).toContain("navigator.clipboard.writeText");
  });

  test("renders the real log entry timestamp instead of a fabricated offset", () => {
    expect(bottomPanelSource).toContain("new Date(entry.at).toLocaleTimeString");
    expect(bottomPanelSource).not.toContain("Date.now() - index * 15000");
  });

  test("shows a warning state for failed actions instead of collapsing them to ready", () => {
    const html = renderToStaticMarkup(
      <BottomPanel
        status="Could not open local project."
        logs={[{ message: "Could not open local project.", at: 1714000000000 }]}
        projectName="Cantilever Demo"
        studyName="Static Stress"
        meshStatus="Ready"
        solverStatus="Idle"
        backendStatus="core"
        onClearLogs={() => undefined}
      />
    );

    expect(html).toContain(">Needs attention</span>");
    expect(html).toContain('class="status-state warning"');
    expect(html).not.toContain('class="status-state ready"');
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
