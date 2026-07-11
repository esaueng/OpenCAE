import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import {
  BoundaryConditionMenu,
  CreateSimulationModal,
  CreateSimulationScreen,
  MaterialLibraryModal
} from "./SimulationWorkflow";

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

  test("renders simulation showcase renders with native overlays instead of inline SVG images", () => {
    const html = renderToStaticMarkup(<CreateSimulationModal open onCreateStatic={vi.fn()} onCreateDynamic={vi.fn()} onClose={vi.fn()} />);

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
    const html = renderToStaticMarkup(<CreateSimulationScreen onCreateStatic={vi.fn()} onCreateDynamic={vi.fn()} />);

    expect(html).toContain("Choose simulation type");
    expect(html).toContain("Static Analysis");
    expect(html).toContain("Dynamic Analysis");
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
});
