import { describe, expect, test } from "vitest";
import { OPENCAE_MODEL_SCHEMA_VERSION, type OpenCAEModelJson } from "@opencae/core";
import { solveSteadyStateThermal } from "../src";

describe("steady-state thermal", () => {
  test("recovers the exact linear temperature and Fourier heat flux in a Tet4", () => {
    const model: OpenCAEModelJson = {
      schema: "opencae.model",
      schemaVersion: OPENCAE_MODEL_SCHEMA_VERSION,
      nodes: { coordinates: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
      materials: [{
        name: "thermal-solid",
        type: "isotropicLinearElastic",
        youngModulus: 1,
        poissonRatio: 0.25,
        thermalConductivity: 10
      }],
      elementBlocks: [{ name: "solid", type: "Tet4", material: "thermal-solid", connectivity: [0, 1, 2, 3] }],
      nodeSets: [{ name: "cold", nodes: [0, 2, 3] }, { name: "hot", nodes: [1] }],
      elementSets: [],
      boundaryConditions: [
        { name: "cold-temperature", type: "prescribedTemperature", nodeSet: "cold", value: 0 },
        { name: "hot-temperature", type: "prescribedTemperature", nodeSet: "hot", value: 100 }
      ],
      loads: [],
      steps: [{
        name: "conduction",
        type: "steadyStateThermal",
        boundaryConditions: ["cold-temperature", "hot-temperature"],
        loads: []
      }]
    };

    const solved = solveSteadyStateThermal(model);
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    expect(Array.from(solved.result.temperature)).toEqual([0, 100, 0, 0]);
    for (let node = 0; node < 4; node += 1) {
      expect(solved.result.heatFlux[node * 3]).toBeCloseTo(-1000, 10);
      expect(solved.result.heatFlux[node * 3 + 1]).toBeCloseTo(0, 10);
      expect(solved.result.heatFlux[node * 3 + 2]).toBeCloseTo(0, 10);
      expect(solved.result.heatFluxMagnitude[node]).toBeCloseTo(1000, 10);
    }
    expect(solved.diagnostics.energyBalanceRelativeError).toBeLessThan(1e-12);
  });
});
