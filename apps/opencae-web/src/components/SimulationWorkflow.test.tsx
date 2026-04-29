import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import type { ResultField, Study } from "@opencae/schema";
import {
  BoundaryConditionMenu,
  CreateSimulationModal,
  CreateSimulationScreen,
  MaterialLibraryModal,
  ResultsFieldSelector,
  StudyTree
} from "./SimulationWorkflow";

const study: Study = {
  id: "study-1",
  projectId: "project-1",
  name: "Static Stress",
  type: "static_stress",
  geometryScope: [{ bodyId: "body-1", entityType: "body", entityId: "body-1", label: "Sample body" }],
  materialAssignments: [{ id: "mat-assign", materialId: "mat-aluminum-6061", selectionRef: "selection-body", status: "complete" }],
  namedSelections: [],
  contacts: [],
  constraints: [{ id: "fixed-1", type: "fixed", selectionRef: "selection-face-a", parameters: {}, status: "complete" }],
  loads: [{ id: "load-1", type: "force", selectionRef: "selection-face-b", parameters: { value: 500, units: "N", direction: [0, 0, -1] }, status: "complete" }],
  meshSettings: { preset: "medium", status: "complete", summary: { nodes: 42381, elements: 26944, warnings: [] } },
  solverSettings: {},
  validation: [],
  runs: [{ id: "run-1", studyId: "study-1", status: "complete", jobId: "job-1", solverBackend: "local", solverVersion: "0.1.0", diagnostics: [] }]
};

const fields: ResultField[] = [
  { id: "field-stress", runId: "run-1", type: "stress", location: "face", values: [1, 2], min: 1, max: 2, units: "MPa" },
  { id: "field-displacement", runId: "run-1", type: "displacement", location: "face", values: [0, 0.1], min: 0, max: 0.1, units: "mm" },
  { id: "field-safety", runId: "run-1", type: "safety_factor", location: "face", values: [1.8], min: 1.8, max: 1.8, units: "" }
];

describe("static simulation workflow components", () => {
  test("renders a simplified create simulation modal with only static and dynamic choices", () => {
    const html = renderToStaticMarkup(<CreateSimulationModal open onCreateStatic={vi.fn()} onCreateDynamic={vi.fn()} onClose={vi.fn()} />);

    expect(html).toContain("Create Simulation");
    expect(html).toContain("Static Analysis");
    expect(html).toContain("Dynamic Analysis");
    expect(html).toContain("Static stress example");
    expect(html).toContain("Dynamic stress frame sequence example");
    expect(html).toContain("Time-dependent");
    expect(html).toContain("Choose simulation type");
    expect(html).toContain(">Create Simulation</button>");
    expect(html).not.toContain("Incompressible");
    expect(html).not.toContain("Frequency Analysis");
    expect(html).not.toContain("Coming soon");
    expect(html).not.toContain("Create Dynamic");
  });

  test("renders a required simulation type screen without a close action", () => {
    const html = renderToStaticMarkup(<CreateSimulationScreen onCreateStatic={vi.fn()} onCreateDynamic={vi.fn()} />);

    expect(html).toContain("Choose simulation type");
    expect(html).toContain("Static Analysis");
    expect(html).toContain("Dynamic Analysis");
    expect(html).toContain(">Create Simulation</button>");
    expect(html).not.toContain("Close create simulation");
  });

  test("renders setup tree statuses and plus actions for simulation setup", () => {
    const html = renderToStaticMarkup(
      <StudyTree
        activeStep="mesh"
        study={study}
        hasGeometry
        hasResults
        runProgress={100}
        onSelect={vi.fn()}
        onOpenBoundaryMenu={vi.fn()}
      />
    );

    expect(html).toContain("Geometry");
    expect(html).toContain("Materials");
    expect(html).toContain("Boundary conditions");
    expect(html).toContain("Numerics");
    expect(html).toContain("Simulation control");
    expect(html).toContain("Result control");
    expect(html).toContain("Mesh");
    expect(html).toContain("Simulation runs");
    expect(html).toContain("Run 1");
    expect(html).toContain("setup-status complete");
  });

  test("renders material library search, grouped defaults, preview fields, and apply actions", () => {
    const html = renderToStaticMarkup(
      <MaterialLibraryModal
        open
        selectedMaterialId="mat-abs"
        assignedSelectionLabel="root"
        unitSystem="SI"
        onSelectMaterial={vi.fn()}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(html).toContain("Material");
    expect(html).toContain("Search materials");
    expect(html).toContain("DEFAULT");
    expect(html).toContain("ABS Plastic");
    expect(html).toContain("Young&#x27;s modulus");
    expect(html).toContain("Poisson");
    expect(html).toContain("Density");
    expect(html).toContain("Assigned Volumes");
    expect(html).toContain("root");
    expect(html).toContain("Apply");
    expect(html).toContain("Cancel");
  });

  test("renders enabled and future boundary condition types", () => {
    const html = renderToStaticMarkup(
      <BoundaryConditionMenu
        open
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    for (const enabled of ["Fixed support", "Prescribed displacement", "Force", "Pressure", "Payload mass"]) {
      expect(html).toContain(enabled);
    }
    for (const future of ["Bolt preload", "Elastic support", "Remote displacement", "Remote force", "Surface load", "Volume load", "Hinge constraint"]) {
      expect(html).toContain(future);
    }
    expect(html).toContain("Coming soon");
  });

  test("renders result selector with enabled result fields and disabled unsupported groups", () => {
    const html = renderToStaticMarkup(
      <ResultsFieldSelector
        resultMode="stress"
        fields={fields}
        unitSystem="SI"
        defaultOpen
        onResultModeChange={vi.fn()}
      />
    );

    expect(html).toContain("Von Mises Stress");
    expect(html).toContain("Total Strain");
    expect(html).toContain("Displacement");
    expect(html).toContain("Cauchy Stress");
    expect(html).toContain("Safety factor");
    expect(html).toContain("Pa");
    expect(html).toContain("result-option disabled");
  });

  test("renders velocity and acceleration as enabled result fields when dynamic frames are present", () => {
    const html = renderToStaticMarkup(
      <ResultsFieldSelector
        resultMode="velocity"
        fields={[
          ...fields,
          { id: "field-velocity", runId: "run-1", type: "velocity", location: "face", values: [1], min: 1, max: 1, units: "mm/s", frameIndex: 1, timeSeconds: 0.005 },
          { id: "field-acceleration", runId: "run-1", type: "acceleration", location: "face", values: [10], min: 10, max: 10, units: "mm/s^2", frameIndex: 1, timeSeconds: 0.005 }
        ]}
        unitSystem="SI"
        defaultOpen
        onResultModeChange={vi.fn()}
      />
    );

    expect(html).toContain("Velocity");
    expect(html).toContain("Acceleration");
    expect(html).toContain("mm/s");
    expect(html).toContain("mm/s^2");
  });
});
