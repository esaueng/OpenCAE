import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import {
  BoundaryConditionMenu,
  CreateSimulationModal,
  CreateSimulationScreen,
  MaterialLibraryModal,
  densityForEditor,
  densityFromEditor,
  stressForEditor,
  stressFromEditor
} from "./SimulationWorkflow";

describe("static simulation workflow components", () => {
  test("renders static, dynamic, and modal simulation choices", () => {
    const html = renderToStaticMarkup(<CreateSimulationModal open onCreateStatic={vi.fn()} onCreateDynamic={vi.fn()} onCreateModal={vi.fn()} onClose={vi.fn()} />);

    expect(html).toContain("Create Simulation");
    expect(html).toContain("Static Analysis");
    expect(html).toContain("Dynamic Analysis");
    expect(html).toContain("Modal Analysis");
    expect(html).toContain("Static stress example");
    expect(html).toContain("Dynamic stress frame sequence example");
    expect(html).toContain("Time-dependent");
    expect(html).toContain("Choose simulation type");
    expect(html).toContain(">Create Simulation</button>");
    expect(html).not.toContain("Incompressible");
    expect(html).not.toContain("Coming soon");
    expect(html).not.toContain("Create Dynamic");
  });

  test("renders simulation showcase renders with native overlays instead of inline SVG images", () => {
    const html = renderToStaticMarkup(<CreateSimulationModal open onCreateStatic={vi.fn()} onCreateDynamic={vi.fn()} onCreateModal={vi.fn()} onClose={vi.fn()} />);

    expect(html).toContain("analysis-showcase analysis-showcase--compact analysis-showcase--static");
    expect(html).toContain("analysis-showcase analysis-showcase--large analysis-showcase--static");
    expect(html).toContain("analysis-showcase analysis-showcase--compact analysis-showcase--dynamic");
    expect(html).toContain("Static stress example");
    expect(html).toContain("Dynamic stress frame sequence example");
    expect(html).toContain("500 N");
    expect(html).toContain("Fixed support");
    expect(html).toContain("Static peak stress");
    expect(html).toContain("Impulse load");
    expect(html).toContain("Frame 1");
    expect(html).toContain("Frame 2");
    expect(html).toContain("Frame 3");
    expect(html).not.toContain("data:image/svg+xml");
  });

  test("renders a required simulation type screen without a close action", () => {
    const html = renderToStaticMarkup(<CreateSimulationScreen onCreateStatic={vi.fn()} onCreateDynamic={vi.fn()} onCreateModal={vi.fn()} />);

    expect(html).toContain("Choose simulation type");
    expect(html).toContain("Static Analysis");
    expect(html).toContain("Dynamic Analysis");
    expect(html).toContain("Modal Analysis");
    expect(html).toContain(">Create Simulation</button>");
    expect(html).not.toContain("Close create simulation");
  });

  test("renders grouped material categories with compatible-process preview and select action", () => {
    const html = renderToStaticMarkup(
      <MaterialLibraryModal
        open
        selectedMaterialId="mat-abs"
        assignedSelectionLabel="root"
        unitSystem="SI"
        onApply={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(html).toContain("Material library");
    expect(html).toContain("Search materials");
    expect(html).toContain("Metals");
    expect(html).toContain("Thermoplastics");
    expect(html).toContain("Composites");
    expect(html).toContain("Photopolymer resins");
    expect(html).toContain("ABS Plastic");
    expect(html).toContain("3 compatible processes");
    expect(html).toContain("Compatible processes");
    expect(html).toContain("CNC machining");
    expect(html).toContain("Injection molding");
    expect(html).toContain("FDM printing");
    expect(html).not.toContain("SLA printing</li>");
    expect(html).toContain("Young&#x27;s modulus");
    expect(html).toContain("Poisson&#x27;s ratio");
    expect(html).toContain("Density");
    expect(html).toContain("Apply to");
    expect(html).toContain("root");
    expect(html).toContain("Select material");
    expect(html).toContain("Cancel");
  });

  test("converts custom material editor values without changing canonical SI storage", () => {
    expect(stressForEditor(68_947_572.93168, "US")).toBeCloseTo(10);
    expect(stressFromEditor(10, "US")).toBeCloseTo(68_947_572.93168);
    expect(densityForEditor(2767.99047102, "US")).toBeCloseTo(0.1);
    expect(densityFromEditor(0.1, "US")).toBeCloseTo(2767.99047102);
    expect(stressFromEditor(stressForEditor(276e6, "SI"), "SI")).toBeCloseTo(276e6);
  });

  test("marks project custom materials unverified and disables deletion while assigned", () => {
    const custom = {
      id: "0ac4dbda-1d37-43c0-b3ac-9d1d2cc28e84",
      name: "Shop aluminum",
      category: "metal" as const,
      youngsModulus: 70e9,
      poissonRatio: 0.33,
      density: 2710,
      yieldStrength: 290e6,
      verification: "user_supplied_unverified" as const
    };
    const html = renderToStaticMarkup(
      <MaterialLibraryModal
        open
        selectedMaterialId={custom.id}
        assignedSelectionLabel="body"
        unitSystem="SI"
        materials={[custom]}
        customMaterialIds={[custom.id]}
        assignedMaterialIds={[custom.id]}
        onApply={vi.fn()}
        onSaveCustomMaterial={vi.fn()}
        onDeleteCustomMaterial={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(html).toContain("User-supplied · unverified");
    expect(html).toContain("Duplicate &amp; edit");
    expect(html).toMatch(/disabled=""[^>]*title="Assigned custom materials cannot be deleted\."[^>]*>Delete/);
  });

  test("renders enabled and future boundary condition types", () => {
    const html = renderToStaticMarkup(
      <BoundaryConditionMenu
        open
        studyType="static_stress"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    for (const enabled of ["Fixed support", "Prescribed displacement", "Face force (total)", "Pressure", "Surface traction", "Volume force", "Remote force", "Equivalent bolt preload", "Payload mass"]) {
      expect(html).toContain(enabled);
    }
    for (const future of ["Elastic support", "Remote displacement", "Hinge constraint"]) {
      expect(html).toContain(future);
    }
    expect(html).toContain("Coming soon");
  });
});
