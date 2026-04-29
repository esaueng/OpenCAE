import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { Project, Study } from "@opencae/schema";
import { StepBar } from "./StepBar";

const project: Project = {
  id: "project-1",
  name: "Collapsed Sidebar",
  schemaVersion: "0.1.0",
  unitSystem: "SI",
  geometryFiles: [],
  studies: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

const study: Study = {
  id: "study-1",
  projectId: "project-1",
  name: "Static Stress",
  type: "static_stress",
  geometryScope: [],
  materialAssignments: [],
  namedSelections: [],
  contacts: [],
  constraints: [],
  loads: [],
  meshSettings: { preset: "medium", status: "not_started" },
  solverSettings: {},
  validation: [],
  runs: []
};

describe("StepBar", () => {
  test("keeps utility controls available when collapsed", () => {
    const html = renderToStaticMarkup(
      <StepBar
        activeStep="model"
        project={project}
        study={study}
        hasResults={false}
        collapsed
        themeMode="dark"
        onSelect={vi.fn()}
        onToggleCollapsed={vi.fn()}
        onToggleTheme={vi.fn()}
        onUnitSystemChange={vi.fn()}
      />
    );

    expect(html).toContain("stepbar collapsed");
    expect(html).toContain("Light");
    expect(html).toContain("Switch to light mode");
    expect(html).not.toContain("Feedback");
    expect(html).not.toContain('href="https://form.esauengineering.com/opencae-feedback"');
    expect(html).not.toContain("GitHub");
    expect(html).not.toContain('href="https://github.com/esaueng/OpenCAE"');
    expect(html).toContain("Metric");
  });

  test("does not visually hide the collapsed utility footer", () => {
    const css = readFileSync(resolve(__dirname, "../styles/app.css"), "utf8");

    expect(css).not.toContain(".stepbar.collapsed .stepbar-footer,\n.stepbar.collapsed .step > span:not(.step-icon)");
    expect(css).toMatch(/\.stepbar\.collapsed\s+\.stepbar-footer\s*\{[\s\S]*?display:\s*grid;/);
  });

  test("does not underline workflow utility links", () => {
    const css = readFileSync(resolve(__dirname, "../styles/app.css"), "utf8");

    expect(css).toMatch(/\.stepbar-link\s*\{[\s\S]*?text-decoration:\s*none;/);
    expect(css).toMatch(/\.stepbar-link:hover,\n\.stepbar-link:focus-visible\s*\{[\s\S]*?text-decoration:\s*none;/);
  });

  test("uses an atom icon for the material step", () => {
    const html = renderToStaticMarkup(
      <StepBar
        activeStep="material"
        project={project}
        study={study}
        hasResults={false}
        collapsed={false}
        themeMode="dark"
        onSelect={vi.fn()}
        onToggleCollapsed={vi.fn()}
        onToggleTheme={vi.fn()}
        onUnitSystemChange={vi.fn()}
      />
    );

    expect(html).toMatch(/lucide-atom[\s\S]*Material/);
  });

  test("does not render a report workflow step", () => {
    const html = renderToStaticMarkup(
      <StepBar
        activeStep="results"
        project={project}
        study={study}
        hasResults={false}
        collapsed={false}
        themeMode="dark"
        onSelect={vi.fn()}
        onToggleCollapsed={vi.fn()}
        onToggleTheme={vi.fn()}
        onUnitSystemChange={vi.fn()}
      />
    );

    expect(html).not.toContain("Report");
    expect(html).not.toContain("lucide-file-text");
  });

  test("shows the active study type in the footer", () => {
    const html = renderToStaticMarkup(
      <StepBar
        activeStep="supports"
        project={project}
        study={{
          ...study,
          name: "Dynamic Structural",
          type: "dynamic_structural",
          solverSettings: {
            startTime: 0,
            endTime: 0.1,
            timeStep: 0.005,
            outputInterval: 0.005,
            dampingRatio: 0.02,
            integrationMethod: "newmark_average_acceleration"
          }
        }}
        hasResults={false}
        collapsed={false}
        themeMode="dark"
        onSelect={vi.fn()}
        onToggleCollapsed={vi.fn()}
        onToggleTheme={vi.fn()}
        onUnitSystemChange={vi.fn()}
      />
    );

    expect(html).toContain("<span>study</span><strong>dynamic</strong>");
  });
});
