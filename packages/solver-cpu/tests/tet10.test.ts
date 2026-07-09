import { describe, expect, test } from "vitest";
import { elevateTet4MeshToTet10, type OpenCAEModelJson } from "@opencae/core";
import {
  computeTet10ElementStiffness,
  computeTet10Volume,
  recoverTet10CentroidStrain,
  solveDynamicMdofTet4Cpu,
  solveStaticLinearTet4Cpu
} from "../src";

const UNIT_TET10_COORDINATES = new Float64Array([
  0, 0, 0,
  1, 0, 0,
  0, 1, 0,
  0, 0, 1,
  0.5, 0, 0,
  0.5, 0.5, 0,
  0, 0.5, 0,
  0, 0, 0.5,
  0.5, 0, 0.5,
  0, 0.5, 0.5
]);

const STEEL = {
  name: "steel",
  type: "isotropicLinearElastic" as const,
  youngModulus: 200000000000,
  poissonRatio: 0.3,
  density: 7850,
  yieldStrength: 250000000
};

describe("Tet10 element", () => {
  test("integrates the exact volume of the unit tetrahedron", () => {
    const volume = computeTet10Volume(UNIT_TET10_COORDINATES);
    expect(volume.ok).toBe(true);
    if (!volume.ok) return;
    expect(volume.volume).toBeCloseTo(1 / 6, 12);
  });

  test("rejects inverted elements", () => {
    // Mirroring through the xy-plane flips the element orientation everywhere.
    const inverted = Float64Array.from(UNIT_TET10_COORDINATES);
    for (let node = 0; node < 10; node += 1) inverted[node * 3 + 2] *= -1;
    const volume = computeTet10Volume(inverted);
    expect(volume.ok).toBe(false);
  });

  test("recovers an imposed uniform strain field exactly (patch test)", () => {
    const exx = 0.001;
    const eyy = 0.002;
    const ezz = -0.0003;
    const gxy = 0.0005;
    const gxz = 0.0002;
    const displacement = new Float64Array(30);
    for (let node = 0; node < 10; node += 1) {
      const x = UNIT_TET10_COORDINATES[node * 3];
      const y = UNIT_TET10_COORDINATES[node * 3 + 1];
      const z = UNIT_TET10_COORDINATES[node * 3 + 2];
      displacement[node * 3] = exx * x + gxy * y + gxz * z;
      displacement[node * 3 + 1] = eyy * y;
      displacement[node * 3 + 2] = ezz * z;
    }

    const strain = recoverTet10CentroidStrain(UNIT_TET10_COORDINATES, displacement);
    expect(strain.ok).toBe(true);
    if (!strain.ok) return;
    expect(strain.strain[0]).toBeCloseTo(exx, 12);
    expect(strain.strain[1]).toBeCloseTo(eyy, 12);
    expect(strain.strain[2]).toBeCloseTo(ezz, 12);
    expect(strain.strain[3]).toBeCloseTo(gxy, 12);
    expect(strain.strain[4]).toBeCloseTo(0, 12);
    expect(strain.strain[5]).toBeCloseTo(gxz, 12);
  });

  test("element stiffness is symmetric and annihilates rigid translations", () => {
    const d = new Float64Array(36);
    // Simple isotropic D-matrix (lambda = mu = 1e9) keeps the check scale-independent.
    const lambda = 1e9;
    const mu = 1e9;
    d[0] = d[7] = d[14] = lambda + 2 * mu;
    d[1] = d[2] = d[6] = d[8] = d[12] = d[13] = lambda;
    d[21] = d[28] = d[35] = mu;

    const stiffness = computeTet10ElementStiffness(UNIT_TET10_COORDINATES, d);
    expect(stiffness.ok).toBe(true);
    if (!stiffness.ok) return;

    let maxEntry = 0;
    let maxAsymmetry = 0;
    for (let row = 0; row < 30; row += 1) {
      for (let col = 0; col < 30; col += 1) {
        maxEntry = Math.max(maxEntry, Math.abs(stiffness.stiffness[row * 30 + col]));
        maxAsymmetry = Math.max(
          maxAsymmetry,
          Math.abs(stiffness.stiffness[row * 30 + col] - stiffness.stiffness[col * 30 + row])
        );
      }
    }
    expect(maxAsymmetry).toBeLessThanOrEqual(maxEntry * 1e-12);

    for (let direction = 0; direction < 3; direction += 1) {
      const translation = new Float64Array(30);
      for (let node = 0; node < 10; node += 1) translation[node * 3 + direction] = 1;
      for (let row = 0; row < 30; row += 1) {
        let force = 0;
        for (let col = 0; col < 30; col += 1) {
          force += stiffness.stiffness[row * 30 + col] * translation[col];
        }
        expect(Math.abs(force)).toBeLessThanOrEqual(maxEntry * 1e-10);
      }
    }
  });
});

type BeamMesh = {
  model: OpenCAEModelJson;
  tipNodeCount: number;
};

const BEAM_LENGTH = 1;
const BEAM_WIDTH = 0.1;
const BEAM_HEIGHT = 0.1;
const TIP_LOAD = 1000;

function buildCantileverBeamModel(elementType: "Tet4" | "Tet10", cellsX: number): BeamMesh {
  const nx = cellsX;
  const ny = 1;
  const nz = 1;
  const nodeIndex = (i: number, j: number, k: number) => i * (ny + 1) * (nz + 1) + j * (nz + 1) + k;
  const coordinates: number[] = [];
  for (let i = 0; i <= nx; i += 1) {
    for (let j = 0; j <= ny; j += 1) {
      for (let k = 0; k <= nz; k += 1) {
        coordinates.push((i / nx) * BEAM_LENGTH, (j / ny) * BEAM_WIDTH, (k / nz) * BEAM_HEIGHT);
      }
    }
  }
  const tet4Elements: number[][] = [];
  for (let i = 0; i < nx; i += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let k = 0; k < nz; k += 1) {
        const c0 = nodeIndex(i, j, k);
        const c1 = nodeIndex(i + 1, j, k);
        const c2 = nodeIndex(i + 1, j + 1, k);
        const c3 = nodeIndex(i, j + 1, k);
        const c4 = nodeIndex(i, j, k + 1);
        const c5 = nodeIndex(i + 1, j, k + 1);
        const c6 = nodeIndex(i + 1, j + 1, k + 1);
        const c7 = nodeIndex(i, j + 1, k + 1);
        tet4Elements.push(
          [c0, c1, c2, c6],
          [c0, c2, c3, c6],
          [c0, c3, c7, c6],
          [c0, c7, c4, c6],
          [c0, c4, c5, c6],
          [c0, c5, c1, c6]
        );
      }
    }
  }

  let finalCoordinates = coordinates;
  let connectivity: number[];
  if (elementType === "Tet10") {
    const elevated = elevateTet4MeshToTet10({ coordinates, elements: tet4Elements });
    finalCoordinates = elevated.coordinates;
    connectivity = elevated.elements.flat();
  } else {
    connectivity = tet4Elements.flat();
  }

  const fixedNodes: number[] = [];
  const tipNodes: number[] = [];
  for (let node = 0; node < finalCoordinates.length / 3; node += 1) {
    const x = finalCoordinates[node * 3];
    if (Math.abs(x) < 1e-9) fixedNodes.push(node);
    if (Math.abs(x - BEAM_LENGTH) < 1e-9) tipNodes.push(node);
  }

  const model: OpenCAEModelJson = {
    schema: "opencae.model",
    schemaVersion: "0.1.0",
    nodes: { coordinates: finalCoordinates },
    materials: [STEEL],
    elementBlocks: [
      {
        name: "beam",
        type: elementType,
        material: "steel",
        connectivity
      }
    ],
    nodeSets: [
      { name: "fixedNodes", nodes: fixedNodes },
      { name: "tipNodes", nodes: tipNodes }
    ],
    elementSets: [],
    boundaryConditions: [
      {
        name: "fixedSupport",
        type: "fixed",
        nodeSet: "fixedNodes",
        components: ["x", "y", "z"]
      }
    ],
    loads: [
      {
        name: "tipLoad",
        type: "nodalForce",
        nodeSet: "tipNodes",
        vector: [0, 0, -TIP_LOAD / tipNodes.length]
      }
    ],
    steps: [
      {
        name: "loadStep",
        type: "staticLinear",
        boundaryConditions: ["fixedSupport"],
        loads: ["tipLoad"]
      }
    ]
  } as OpenCAEModelJson;

  return { model, tipNodeCount: tipNodes.length };
}

function tipDeflection(model: OpenCAEModelJson): number {
  const result = solveStaticLinearTet4Cpu(model, { tolerance: 1e-12 });
  expect(result.ok).toBe(true);
  if (!result.ok) return 0;
  let maxDrop = 0;
  const coordinates = model.nodes.coordinates;
  for (let node = 0; node < coordinates.length / 3; node += 1) {
    if (Math.abs(coordinates[node * 3] - BEAM_LENGTH) < 1e-9) {
      maxDrop = Math.max(maxDrop, -result.result.displacement[node * 3 + 2]);
    }
  }
  return maxDrop;
}

describe("Tet10 cantilever fidelity", () => {
  const analyticTipDeflection =
    (TIP_LOAD * BEAM_LENGTH ** 3) /
    (3 * STEEL.youngModulus * ((BEAM_WIDTH * BEAM_HEIGHT ** 3) / 12));

  test("Tet10 relieves the bending lock that makes coarse Tet4 results overly stiff", () => {
    const tet4 = tipDeflection(buildCantileverBeamModel("Tet4", 5).model);
    const tet10 = tipDeflection(buildCantileverBeamModel("Tet10", 5).model);

    // Coarse linear tets lock in bending; quadratic tets should recover most of the
    // Euler-Bernoulli deflection on the same geometry.
    expect(tet10).toBeGreaterThan(tet4 * 1.3);
    expect(tet10).toBeGreaterThan(analyticTipDeflection * 0.6);
    expect(tet10).toBeLessThan(analyticTipDeflection * 1.2);
  });

  test("Tet10 dynamic solve runs with calibrated Rayleigh damping and exact mass", () => {
    const { model } = buildCantileverBeamModel("Tet10", 3);
    const result = solveDynamicMdofTet4Cpu(model, {
      endTime: 0.02,
      timeStep: 0.002,
      outputInterval: 0.004,
      dampingRatio: 0.02,
      loadProfile: "ramp"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.frames.length).toBeGreaterThan(2);
    expect(result.diagnostics.totalMass).toBeCloseTo(
      STEEL.density * BEAM_LENGTH * BEAM_WIDTH * BEAM_HEIGHT,
      6
    );
    expect(result.diagnostics.rayleighCalibration?.method).toBe("modal_estimate");
    const frequency = result.diagnostics.rayleighCalibration?.fundamentalFrequencyHz ?? 0;
    // Euler-Bernoulli puts the first bending mode of this beam near 82 Hz.
    expect(frequency).toBeGreaterThan(30);
    expect(frequency).toBeLessThan(300);
    expect(result.diagnostics.rayleighAlpha).toBeGreaterThan(0);
    expect(result.diagnostics.rayleighBeta).toBeGreaterThan(0);
  });
});
