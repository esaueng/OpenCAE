import { describe, expect, it } from "vitest";
import type { CoreVolumeMeshArtifact } from "@opencae/mesh-intake";
import { actualElementOrderForArtifact, coreAnalysisTypeForStudy, formatElementOrderFallbackWarning } from "./wasmMeshing";

function artifactWithElementType(type: "Tet4" | "Tet10"): Pick<CoreVolumeMeshArtifact, "elements"> {
  return { elements: [{ type, connectivity: [] }] };
}

describe("wasm mesh element-order fallback presentation", () => {
  it("preserves modal analysis when dispatching the generated Core model", () => {
    expect(coreAnalysisTypeForStudy({ type: "static_stress" })).toBe("static_stress");
    expect(coreAnalysisTypeForStudy({ type: "dynamic_structural" })).toBe("dynamic_structural");
    expect(coreAnalysisTypeForStudy({ type: "modal_analysis" })).toBe("modal_analysis");
  });

  it("uses the generated artifact element type as the solver order", () => {
    expect(actualElementOrderForArtifact(artifactWithElementType("Tet4"))).toBe(1);
    expect(actualElementOrderForArtifact(artifactWithElementType("Tet10"))).toBe(2);
  });

  it("explains a browser-DOF Tet4 fallback without implying the quality gate was lowered", () => {
    const warning = formatElementOrderFallbackWarning({
      requested: 2,
      used: 1,
      reason: "browser_dof_limit",
      quadraticNodeCount: 40_907
    });

    expect(warning).toContain("40,907 quadratic nodes");
    expect(warning).toContain("122,721 displacement DOFs");
    expect(warning).toContain("safe linear Tet4 mesh");
    expect(warning).toContain("quality floor remains enforced");
  });
});
