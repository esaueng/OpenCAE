import { describe, expect, test } from "vitest";
import { singleTetStaticFixture } from "@opencae/examples";
import type { OpenCAEModelJson } from "@opencae/core";
import {
  combineStaticLinearTetResults,
  computePrincipalStressMeasures,
  solveStaticLinearTet,
  solveStaticLinearTetLoadCases,
  type SolveProgressEvent
} from "../src";

function caseModel(): OpenCAEModelJson {
  return {
    ...singleTetStaticFixture,
    loads: [
      { name: "caseA", type: "nodalForce", nodeSet: "loadNodes", vector: [100, 0, -100] },
      { name: "caseB", type: "nodalForce", nodeSet: "loadNodes", vector: [0, 60, -50] },
      { name: "direct", type: "nodalForce", nodeSet: "loadNodes", vector: [100, -30, -75] }
    ],
    steps: [{
      name: "directStep",
      type: "staticLinear",
      boundaryConditions: ["fixedSupport", "settlement", "supportY", "supportZ"],
      loads: ["direct"]
    }]
  };
}

describe("static load-case batch solving", () => {
  test("rejects an over-limit batch before shared stiffness assembly", () => {
    const model = caseModel();
    const solved = solveStaticLinearTetLoadCases(
      model,
      model.steps[0]!.boundaryConditions,
      [{ id: "a", loadNames: ["caseA"] }],
      { maxDofs: 3 }
    );

    expect(solved.ok).toBe(false);
    expect(solved.ok ? undefined : solved.error.code).toBe("max-dofs-exceeded");
    expect(solved.ok ? undefined : solved.diagnostics?.dofs).toBe(12);
  });

  test("assembles and reduces K once, then warm-starts each case", () => {
    const progress: SolveProgressEvent[] = [];
    const model = caseModel();
    const boundaryConditions = model.steps[0]!.boundaryConditions;
    const solved = solveStaticLinearTetLoadCases(model, boundaryConditions, [
      { id: "a", loadNames: ["caseA"] },
      { id: "a-repeat", loadNames: ["caseA"] }
    ], { hooks: { onProgress: (event) => progress.push(event) } });

    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    expect(progress.filter((event) => event.phase === "assemble" && event.completed === event.total)).toHaveLength(1);
    expect(solved.cases[1]!.diagnostics.iterations).toBe(0);
  });

  test("matches a direct solve for signed tensor superposition and recomputed von Mises", () => {
    const model = caseModel();
    const boundaryConditions = model.steps[0]!.boundaryConditions;
    const batch = solveStaticLinearTetLoadCases(model, boundaryConditions, [
      { id: "a", loadNames: ["caseA"] },
      { id: "b", loadNames: ["caseB"] }
    ]);
    const direct = solveStaticLinearTet(model, { solverMode: "sparse" });
    expect(batch.ok).toBe(true);
    expect(direct.ok).toBe(true);
    if (!batch.ok || !direct.ok) return;

    const combined = combineStaticLinearTetResults(batch.prepared, [
      { factor: 1, result: batch.cases[0]!.result },
      { factor: -0.5, result: batch.cases[1]!.result }
    ]);
    expect(combined.ok).toBe(true);
    if (!combined.ok) return;
    for (let index = 0; index < combined.result.displacement.length; index += 1) {
      expect(combined.result.displacement[index]).toBeCloseTo(direct.result.displacement[index], 8);
      expect(combined.result.reactionForce[index]).toBeCloseTo(direct.result.reactionForce[index], 8);
    }
    for (let index = 0; index < combined.result.stress.length; index += 1) {
      expect(combined.result.stress[index]).toBeCloseTo(direct.result.stress[index], 7);
    }
    for (let index = 0; index < combined.result.vonMises.length; index += 1) {
      expect(combined.result.vonMises[index]).toBeCloseTo(direct.result.vonMises[index], 7);
      const combinedPrincipal = computePrincipalStressMeasures(combined.result.stress.subarray(index * 6, index * 6 + 6));
      const directPrincipal = computePrincipalStressMeasures(direct.result.stress.subarray(index * 6, index * 6 + 6));
      expect(combinedPrincipal.principalMax).toBeCloseTo(directPrincipal.principalMax, 7);
      expect(combinedPrincipal.principalMin).toBeCloseTo(directPrincipal.principalMin, 7);
      expect(combinedPrincipal.maxShear).toBeCloseTo(directPrincipal.maxShear, 7);
    }
  });
});
