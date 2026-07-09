import { describe, expect, test } from "vitest";
import { bracketActualMeshFixture, singleTetStaticFixture } from "@opencae/examples";
import {
  connectedComponents,
  nodeSetFromSurfaceSet,
  normalizeModelJson,
  solverSurfaceMeshFromModel,
  surfaceArea,
  type OpenCAEModelJson,
  type SolverSurfaceMesh,
  type SurfaceSetJson
} from "@opencae/core";
import { createHexBarModel, createStructuredCantileverModel, dynamicLoadedModel } from "./helpers";
import {
  solveDynamicLinearTetMDOF,
  recoverNodalVonMisesFromElements,
  solveStaticLinearTet,
  solveStaticLinearTet4Cpu
} from "../src";
import {
  hasAbruptStressDiscontinuity,
  SAFETY_FACTOR_DISPLAY_CAP,
  SAFETY_FACTOR_DISPLAY_FLOOR
} from "../src/results";

describe("Core validation suite static benchmarks", () => {
  test("axial bar tension tracks F/A stress, FL/AE displacement, and reaction balance", () => {
    const length = 1;
    const area = 1;
    const youngModulus = 1000;
    const force = 100;
    const model = createHexBarModel({
      length,
      youngModulus,
      loads: [{ name: "axialLoad", type: "surfaceForce", surfaceSet: "rightFace", totalForce: [force, 0, 0] }],
      stepType: "staticLinear"
    });

    const result = solveStaticLinearTet(model, { method: "sparse", tolerance: 1e-12 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rightNodes = getNodeSet(model, "rightNodes");
    const meanTipDisplacement = mean(rightNodes.map((node) => result.result.displacement[node * 3]));
    const expectedDisplacement = (force * length) / (area * youngModulus);
    const expectedStress = force / area;
    const reaction = sumVectorDofs(result.result.reactionForce);

    expect(meanTipDisplacement).toBeCloseTo(expectedDisplacement, 0);
    expect(result.diagnostics.maxVonMisesStress).toBeGreaterThan(0.25 * expectedStress);
    expect(result.diagnostics.maxVonMisesStress).toBeLessThan(2.5 * expectedStress);
    expect(reaction[0]).toBeCloseTo(-force, 8);
    expect(reaction[1]).toBeCloseTo(0, 8);
    expect(reaction[2]).toBeCloseTo(0, 8);
  });

  test("cantilever benchmark stays within documented coarse Tet4 beam-theory tolerances", () => {
    const length = 4;
    const youngModulus = 1e6;
    const force = 10;
    const height = 1;
    const width = 1;
    const inertia = (width * height ** 3) / 12;
    const expectedTipDisplacement = (force * length ** 3) / (3 * youngModulus * inertia);
    const expectedStress = (force * length * (height / 2)) / inertia;
    const model = createHexBarModel({
      length,
      youngModulus,
      fixedLeftFace: true,
      loads: [{ name: "tipShear", type: "surfaceForce", surfaceSet: "rightFace", totalForce: [0, -force, 0] }],
      stepType: "staticLinear"
    });

    const result = solveStaticLinearTet(model, { method: "sparse", tolerance: 1e-12 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rightNodes = getNodeSet(model, "rightNodes");
    const meanTipDisplacement = Math.abs(mean(rightNodes.map((node) => result.result.displacement[node * 3 + 1])));
    const reaction = sumVectorDofs(result.result.reactionForce);

    expect(meanTipDisplacement).toBeGreaterThan(0.05 * expectedTipDisplacement);
    expect(meanTipDisplacement).toBeLessThan(25 * expectedTipDisplacement);
    expect(result.diagnostics.maxVonMisesStress).toBeGreaterThan(0.05 * expectedStress);
    expect(result.diagnostics.maxVonMisesStress).toBeLessThan(25 * expectedStress);
    expect(reaction[0]).toBeCloseTo(0, 8);
    expect(reaction[1]).toBeCloseTo(force, 8);
    expect(reaction[2]).toBeCloseTo(0, 8);
  });

  test("aluminum cantilever sanity result matches app-facing MPa mm N bands", () => {
    const force = 500;
    const model = createStructuredCantileverModel({
      length: 0.18,
      width: 0.024,
      height: 0.024,
      force,
      xDivisions: 16,
      yDivisions: 3,
      zDivisions: 3
    });

    const result = solveStaticLinearTet(model, { method: "sparse", tolerance: 1e-10, maxIterations: 20000 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const coreResult = result.result.coreResult;
    expect(coreResult?.summary.provenance).toBeDefined();
    expect(coreResult?.summary.maxStressUnits).toBe("MPa");
    expect(coreResult?.summary.maxDisplacementUnits).toBe("mm");
    expect(coreResult?.summary.reactionForceUnits).toBe("N");

    const maxStressMpa = coreResult?.summary.maxStress ?? 0;
    const maxDisplacementMm = coreResult?.summary.maxDisplacement ?? 0;
    const reactionForce = coreResult?.summary.reactionForce ?? 0;

    expect(maxStressMpa).toBeGreaterThanOrEqual(25);
    expect(maxStressMpa).toBeLessThanOrEqual(45);
    expect(maxDisplacementMm).toBeGreaterThanOrEqual(0.35);
    expect(maxDisplacementMm).toBeLessThanOrEqual(0.75);
    expect(reactionForce).toBeGreaterThanOrEqual(495);
    expect(reactionForce).toBeLessThanOrEqual(505);
    expect(Number.isFinite(coreResult?.summary.safetyFactor)).toBe(true);
  });

  test("cantilever stress contour uses aligned recovered surface nodal values", () => {
    const model = createStructuredCantileverModel({
      length: 0.18,
      width: 0.024,
      height: 0.024,
      force: 500,
      xDivisions: 16,
      yDivisions: 3,
      zDivisions: 3
    });

    const result = solveStaticLinearTet(model, { method: "sparse", tolerance: 1e-10, maxIterations: 20000 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const coreResult = result.result.coreResult;
    const surfaceMesh = coreResult?.surfaceMesh;
    const stressField = coreResult?.fields.find((field) => field.id === "stress-surface");
    const displacementField = coreResult?.fields.find((field) => field.id === "displacement-surface");
    const engineeringStressField = coreResult?.fields.find((field) => field.id === "stress-von-mises-element");
    const safetyFactorField = coreResult?.fields.find((field) => field.id === "safety-factor");

    expect(surfaceMesh).toBeDefined();
    expect(stressField?.location).toBe("node");
    expect(stressField?.units).toBe("MPa");
    expect(stressField?.surfaceMeshRef).toBe(surfaceMesh?.id);
    expect(stressField?.visualizationSource).toBe("volume_weighted_nodal_recovery");
    expect(stressField?.engineeringSource).toBe("raw_element_von_mises");
    expect(stressField?.values).toHaveLength(surfaceMesh?.nodes.length ?? -1);
    expect(displacementField?.units).toBe("mm");
    expect(displacementField?.values).toHaveLength(surfaceMesh?.nodes.length ?? -1);
    expect(displacementField?.vectors).toHaveLength(surfaceMesh?.nodes.length ?? -1);
    const normalized = normalizeModelJson(model);
    expect(normalized.ok).toBe(true);
    if (!normalized.ok || !surfaceMesh || !stressField || !displacementField) return;
    const recoveredNodalVonMises = recoverNodalVonMisesFromElements(normalized.model, result.result.vonMises);
    const expectedSurfaceStress = surfaceMesh.nodeMap.map((volumeNode) => recoveredNodalVonMises[volumeNode] / 1_000_000);
    const expectedSurfaceDisplacement = surfaceMesh.nodeMap.map((volumeNode) => {
      const offset = volumeNode * 3;
      return Math.hypot(
        result.result.displacement[offset],
        result.result.displacement[offset + 1],
        result.result.displacement[offset + 2]
      ) * 1000;
    });
    const expectedSurfaceDisplacementVectors = surfaceMesh.nodeMap.map((volumeNode) => {
      const offset = volumeNode * 3;
      return [
        result.result.displacement[offset] * 1000,
        result.result.displacement[offset + 1] * 1000,
        result.result.displacement[offset + 2] * 1000
      ];
    });
    for (let index = 0; index < surfaceMesh.nodes.length; index += 1) {
      expect(stressField.values[index]).toBeCloseTo(expectedSurfaceStress[index] ?? 0, 12);
      expect(displacementField.values[index]).toBeCloseTo(expectedSurfaceDisplacement[index] ?? 0, 12);
      expect(displacementField.vectors?.[index]?.[0]).toBeCloseTo(expectedSurfaceDisplacementVectors[index]?.[0] ?? 0, 12);
      expect(displacementField.vectors?.[index]?.[1]).toBeCloseTo(expectedSurfaceDisplacementVectors[index]?.[1] ?? 0, 12);
      expect(displacementField.vectors?.[index]?.[2]).toBeCloseTo(expectedSurfaceDisplacementVectors[index]?.[2] ?? 0, 12);
    }
    expect(engineeringStressField?.location).toBe("element");
    expect(engineeringStressField?.surfaceMeshRef).toBeUndefined();
    expect(coreResult?.summary.maxStress).toBe(engineeringStressField?.max);
    expect(coreResult?.summary.safetyFactor).toBe(safetyFactorField?.min);

    const safetyFactorSurfaceField = coreResult?.fields.find((field) => field.id === "safety-factor-surface");
    expect(safetyFactorSurfaceField?.location).toBe("node");
    expect(safetyFactorSurfaceField?.units).toBe("ratio");
    expect(safetyFactorSurfaceField?.surfaceMeshRef).toBe(surfaceMesh.id);
    expect(safetyFactorSurfaceField?.values).toHaveLength(surfaceMesh.nodes.length);
    const yieldStrength = model.materials[0]!.yieldStrength ?? 0;
    expect(yieldStrength).toBeGreaterThan(0);
    for (let index = 0; index < surfaceMesh.nodes.length; index += 1) {
      const nodalVonMises = recoveredNodalVonMises[surfaceMesh.nodeMap[index]!] ?? 0;
      // Zero recovered stress renders as SAFEST (the display cap), never 0, and finite
      // ratios clamp into the display range — matching the web clampSafetyFactor convention.
      const expected = nodalVonMises > 0
        ? Math.min(SAFETY_FACTOR_DISPLAY_CAP, Math.max(SAFETY_FACTOR_DISPLAY_FLOOR, yieldStrength / nodalVonMises))
        : SAFETY_FACTOR_DISPLAY_CAP;
      const actual = safetyFactorSurfaceField?.values[index] ?? Number.NaN;
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-9 * Math.max(1, expected));
    }
    expect(new Set(stressField?.values.map((value) => value.toPrecision(8))).size).toBeGreaterThan(24);

    const fixedStress = averageStressNearX(surfaceMesh!, stressField!.values, 0, 0.025);
    const freeStress = averageStressNearX(surfaceMesh!, stressField!.values, 0.18, 0.025);
    expect(fixedStress).toBeGreaterThan(freeStress * 1.6);

    const highStressNodes = highStressSurfaceNodes(surfaceMesh!, stressField!.values, 0.85);
    expect(highStressNodes.length).toBeGreaterThan(8);
    expect(uniqueRounded(highStressNodes.map((entry) => entry.node[1]), 5).size).toBeGreaterThan(1);
    expect(uniqueRounded(highStressNodes.map((entry) => entry.node[2]), 5).size).toBeGreaterThan(1);
  });

  test("static Core result includes stress visualization diagnostics", () => {
    const model = createStructuredCantileverModel({
      length: 0.18,
      width: 0.024,
      height: 0.024,
      force: 500,
      xDivisions: 16,
      yDivisions: 3,
      zDivisions: 3
    });

    const result = solveStaticLinearTet(model, { method: "sparse", tolerance: 1e-10, maxIterations: 20000 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const coreResult = result.result.coreResult;
    const stressField = coreResult?.fields.find((field) => field.id === "stress-surface");
    const displacementField = coreResult?.fields.find((field) => field.id === "displacement-surface");
    const diagnostic = coreResult?.diagnostics.find(isStressVisualizationDiagnostic);

    expect(diagnostic).toBeDefined();
    expect(diagnostic?.engineeringStressMaxMpa).toBeCloseTo(coreResult?.summary.maxStress ?? 0, 12);
    expect(diagnostic?.plotStressMinMpa).toBe(stressField?.min);
    expect(diagnostic?.plotStressMaxMpa).toBe(stressField?.max);
    expect(diagnostic?.stressRecoveryMethod).toBe("volume_weighted_nodal_recovery");
    expect(diagnostic?.surfaceNodeCount).toBe(coreResult?.surfaceMesh?.nodes.length);
    expect(diagnostic?.surfaceTriangleCount).toBe(coreResult?.surfaceMesh?.triangles.length);
    expect(diagnostic?.stressFieldValueCount).toBe(stressField?.values.length);
    expect(diagnostic?.displacementFieldValueCount).toBe(displacementField?.values.length);
    expect(diagnostic?.stressFieldLocation).toBe("node");
    expect(diagnostic?.surfaceMeshRef).toBe(coreResult?.surfaceMesh?.id);
    expect(diagnostic?.visualizationSource).toBe("volume_weighted_nodal_recovery");
    expect(diagnostic?.fieldSurfaceAlignment).toBe("ok");
    expect(diagnostic?.fixedNodeCount).toBeGreaterThan(0);
    expect(diagnostic?.loadNodeCount).toBeGreaterThan(0);
    expect(diagnostic?.appliedLoadVector[0]).toBeCloseTo(0, 12);
    expect(diagnostic?.appliedLoadVector[1]).toBeCloseTo(0, 12);
    expect(diagnostic?.appliedLoadVector[2]).toBeCloseTo(-500, 6);
    expect(diagnostic?.reactionVector[2]).toBeCloseTo(500, 6);
    expect(diagnostic?.fixedCentroid[0]).toBeCloseTo(0, 12);
    expect(diagnostic?.loadCentroid[0]).toBeCloseTo(0.18, 12);
    expect(diagnostic?.effectiveLeverArmMm).toBeCloseTo(180, 8);
    expect(diagnostic?.stressByBeamAxisBin).toHaveLength(20);
    expect(diagnostic?.stressByBeamAxisBin[0]).toEqual(
      expect.objectContaining({
        axisCenter: expect.any(Number),
        meanStressMpa: expect.any(Number),
        maxStressMpa: expect.any(Number)
      })
    );
    const populatedBins = diagnostic?.stressByBeamAxisBin.filter((bin) => bin.nodeCount > 0) ?? [];
    expect(populatedBins.length).toBeGreaterThan(4);
    expect(populatedBins[0]?.maxStressMpa).toBeGreaterThan((populatedBins.at(-1)?.maxStressMpa ?? 0) * 1.4);
    expect(diagnostic?.warnings).not.toContain("Stress field has abrupt spatial discontinuity; verify surface node mapping, load/support mapping, or stress recovery.");

    const coreDiagnostic = coreResult?.diagnostics.find(isCoreSolveDiagnostic);
    expect(coreDiagnostic?.displayMaxStressMpa).toBeCloseTo(coreResult?.summary.maxStress ?? 0, 12);
    expect(coreDiagnostic?.displayMaxDisplacementMm).toBeCloseTo(coreResult?.summary.maxDisplacement ?? 0, 12);
    expect(coreDiagnostic?.rawMaxStressPa).toBeGreaterThan(0);
    expect(coreDiagnostic?.fieldSurfaceAlignment).toBe("ok");
    expect(coreDiagnostic?.solverMethod).toBe("opencae-core-sparse-tet");
    expect(coreDiagnostic?.warnings).toEqual(diagnostic?.warnings);
  });

  test("stress discontinuity diagnostic detects synthetic two-zone fields without flagging gradual trends", () => {
    const gradual = Array.from({ length: 20 }, (_value, bin) => ({
      bin,
      axisCenter: bin + 0.5,
      meanStressMpa: 1 + bin * 0.4,
      maxStressMpa: 1.2 + bin * 0.4,
      nodeCount: 4
    }));
    const twoZone = Array.from({ length: 20 }, (_value, bin) => ({
      bin,
      axisCenter: bin + 0.5,
      meanStressMpa: bin < 10 ? 2 : 18,
      maxStressMpa: bin < 10 ? 2.5 : 19,
      nodeCount: 4
    }));

    expect(hasAbruptStressDiscontinuity(gradual)).toBe(false);
    expect(hasAbruptStressDiscontinuity(twoZone)).toBe(true);
  });

  test("visualization smoothing is explicit and does not change engineering max stress", () => {
    const model = createStructuredCantileverModel({
      length: 0.18,
      width: 0.024,
      height: 0.024,
      force: 500,
      xDivisions: 8,
      yDivisions: 2,
      zDivisions: 2
    });

    const raw = solveStaticLinearTet(model, { method: "sparse", tolerance: 1e-10, maxIterations: 20000 });
    const smoothed = solveStaticLinearTet(model, {
      method: "sparse",
      tolerance: 1e-10,
      maxIterations: 20000,
      visualizationSmoothing: { iterations: 1, alpha: 0.25 }
    });

    expect(raw.ok).toBe(true);
    expect(smoothed.ok).toBe(true);
    if (!raw.ok || !smoothed.ok) return;
    const rawStress = raw.result.coreResult?.fields.find((field) => field.id === "stress-surface");
    const smoothedStress = smoothed.result.coreResult?.fields.find((field) => field.id === "stress-surface");
    const smoothedDiagnostic = smoothed.result.coreResult?.diagnostics.find(isStressVisualizationDiagnostic);

    expect(smoothed.result.coreResult?.summary.maxStress).toBe(raw.result.coreResult?.summary.maxStress);
    expect(smoothedStress?.visualizationSource).toBe("volume_weighted_nodal_recovery_laplacian_smoothed");
    expect(smoothedDiagnostic?.stressRecoveryMethod).toBe("volume_weighted_nodal_recovery_laplacian_smoothed");
    expect(smoothedStress?.values).not.toEqual(rawStress?.values);
  });

  test("pressure patch total force equals pressure times area and balances reactions", () => {
    const pressure = 25;
    const model = createHexBarModel({
      length: 1,
      youngModulus: 1000,
      fixedLeftFace: true,
      loads: [{ name: "pressure", type: "pressure", surfaceSet: "rightFace", pressure, direction: [1, 0, 0] }],
      stepType: "staticLinear"
    });
    const rightSurface = getSurfaceSet(model, "rightFace");
    const force = pressure * surfaceArea(rightSurface, model.surfaceFacets ?? []);

    const result = solveStaticLinearTet(model, { method: "sparse", tolerance: 1e-12 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reaction = sumVectorDofs(result.result.reactionForce);
    expect(force).toBeCloseTo(pressure);
    expect(reaction[0]).toBeCloseTo(-force, 8);
    expect(reaction[1]).toBeCloseTo(0, 8);
    expect(reaction[2]).toBeCloseTo(0, 8);
  });

  test("body gravity total force equals mass times acceleration", () => {
    const density = 7;
    const acceleration = -9.81;
    const model = createHexBarModel({
      length: 1,
      youngModulus: 1000,
      density,
      fixedLeftFace: true,
      loads: [{ name: "gravity", type: "bodyGravity", acceleration: [0, 0, acceleration] }],
      stepType: "staticLinear"
    });

    const result = solveStaticLinearTet(model, { method: "sparse", tolerance: 1e-12 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reaction = sumVectorDofs(result.result.reactionForce);
    expect(reaction[0]).toBeCloseTo(0, 8);
    expect(reaction[1]).toBeCloseTo(0, 8);
    expect(reaction[2]).toBeCloseTo(-(density * acceleration), 8);
  });
});

describe("Core validation suite sparse solver", () => {
  test("dense and sparse match on a constrained small mesh", () => {
    const dense = solveStaticLinearTet(singleTetStaticFixture, { method: "dense" });
    const sparse = solveStaticLinearTet(singleTetStaticFixture, { method: "sparse", tolerance: 1e-12 });

    expect(dense.ok).toBe(true);
    expect(sparse.ok).toBe(true);
    if (!dense.ok || !sparse.ok) return;
    expect(sparse.diagnostics.converged).toBe(true);
    expect(sparse.diagnostics.iterations).toBeGreaterThan(0);
    for (let index = 0; index < dense.result.displacement.length; index += 1) {
      expect(sparse.result.displacement[index]).toBeCloseTo(dense.result.displacement[index], 8);
    }
  });

  test("singular unconstrained model fails clearly while constrained model solves", () => {
    const singular: OpenCAEModelJson = {
      ...singleTetStaticFixture,
      boundaryConditions: [],
      steps: [{ name: "loadStep", type: "staticLinear", boundaryConditions: [], loads: ["tipLoad"] }]
    };

    const failed = solveStaticLinearTet4Cpu(singular, { method: "sparse" });
    const solved = solveStaticLinearTet4Cpu(singleTetStaticFixture, { method: "sparse" });

    expect(failed.ok).toBe(false);
    expect(failed.ok ? undefined : failed.error.code).toBe("singular-system");
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    expect(solved.diagnostics.relativeResidual).toBeLessThan(1e-8);
  });
});

describe("Core validation suite dynamic benchmarks", () => {
  test("zero load remains zero", () => {
    const model = createHexBarModel({
      length: 1,
      youngModulus: 1000,
      loads: [],
      stepType: "dynamicLinear"
    });

    const result = solveDynamicLinearTetMDOF(model);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const frame of result.result.frames) {
      expect(maxAbs(frame.displacement.values)).toBe(0);
      expect(maxAbs(frame.velocity.values)).toBe(0);
      expect(maxAbs(frame.acceleration.values)).toBe(0);
    }
  });

  test("ramp starts near zero, step peaks early, and half-sine starts and ends at zero load", () => {
    const ramp = solveDynamicLinearTetMDOF(dynamicLoadedModel("ramp"));
    const step = solveDynamicLinearTetMDOF(dynamicLoadedModel("step"));
    const sine = solveDynamicLinearTetMDOF(dynamicLoadedModel("half_sine"));

    expect(ramp.ok && step.ok && sine.ok).toBe(true);
    if (!ramp.ok || !step.ok || !sine.ok) return;
    expect(maxAbs(ramp.result.frames[0].displacement.values)).toBeLessThan(1e-14);
    expect(step.result.frames[0].loadScale).toBe(1);
    expect(maxAbs(step.result.frames[0].acceleration.values)).toBeGreaterThan(0);
    expect(sine.result.frames[0].loadScale).toBeCloseTo(0);
    expect(sine.result.frames.at(-1)?.loadScale ?? -1).toBeCloseTo(0);
  });

  test("outputInterval controls frame count and response changes across frames", () => {
    const result = solveDynamicLinearTetMDOF(dynamicLoadedModel("step"), {
      endTime: 0.03,
      timeStep: 0.005,
      outputInterval: 0.015,
      dampingRatio: 0
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.frames.map((frame) => frame.timeSeconds)).toEqual([0, 0.015, 0.03]);
    const signatures = new Set(
      result.result.frames.map((frame) =>
        Array.from(frame.displacement.values).map((value) => value.toExponential(6)).join(",")
      )
    );
    expect(signatures.size).toBeGreaterThan(1);
  });

  test("dynamic diagnostics expose Rayleigh coefficients and frame reaction balance", () => {
    const result = solveDynamicLinearTetMDOF(dynamicLoadedModel("ramp"), {
      rayleighAlpha: 0.3,
      rayleighBeta: 0.002,
      endTime: 0.02,
      timeStep: 0.005,
      outputInterval: 0.01
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics.rayleighAlpha).toBe(0.3);
    expect(result.diagnostics.rayleighBeta).toBe(0.002);
    expect(result.diagnostics.newmarkGamma).toBe(0.5);
    expect(result.diagnostics.newmarkBeta).toBe(0.25);
    expect(result.diagnostics.reactionBalance.every((entry) => Number.isFinite(entry.relativeImbalance))).toBe(true);
    expect(result.diagnostics.reactionBalance.at(-1)?.relativeImbalance).toBeLessThan(1e-6);
  });

  test("dynamic validation fails for missing density and excessive frame budget", () => {
    const missingDensity = solveDynamicLinearTetMDOF(singleTetStaticFixture);
    const tooManyFrames = solveDynamicLinearTetMDOF(dynamicLoadedModel("ramp"), {
      endTime: 1,
      timeStep: 0.001,
      outputInterval: 0.001,
      maxFrames: 10
    });

    expect(missingDensity.ok).toBe(false);
    expect(missingDensity.ok ? undefined : missingDensity.error.message).toContain("Dynamic solve requires material density.");
    expect(tooManyFrames.ok).toBe(false);
    expect(tooManyFrames.ok ? undefined : tooManyFrames.error.code).toBe("too-many-frames");
    expect(tooManyFrames.ok ? undefined : tooManyFrames.error.message).toContain("exceeding maxFrames");
  });
});

describe("Core validation suite complex geometry regression", () => {
  test("bracket-like Tet mesh stays connected through static and dynamic result topology", () => {
    const components = connectedComponents(bracketActualMeshFixture);
    const support = bracketActualMeshFixture.surfaceSets?.find((set) => set.name === "base_mount");
    const load = bracketActualMeshFixture.surfaceSets?.find((set) => set.name === "upright_load");

    expect(components.componentCount).toBe(1);
    expect(support?.facets.length).toBeGreaterThan(0);
    expect(load?.facets.length).toBeGreaterThan(0);
    expect(nodeSetFromSurfaceSet(support!, bracketActualMeshFixture.surfaceFacets ?? []).length).toBeGreaterThan(0);
    expect(nodeSetFromSurfaceSet(load!, bracketActualMeshFixture.surfaceFacets ?? []).length).toBeGreaterThan(0);

    const staticResult = solveStaticLinearTet(bracketActualMeshFixture, { method: "sparse", tolerance: 1e-10 });
    const dynamicResult = solveDynamicLinearTetMDOF(bracketActualMeshFixture, {
      stepIndex: 1,
      maxFrames: 50,
      tolerance: 1e-10
    });

    expect(staticResult.ok).toBe(true);
    expect(dynamicResult.ok).toBe(true);
    if (!staticResult.ok || !dynamicResult.ok) return;
    const staticSurface = staticResult.result.coreResult?.surfaceMesh ?? solverSurfaceMeshFromModel(bracketActualMeshFixture);
    const dynamicSurface = dynamicResult.result.coreResult?.surfaceMesh ?? solverSurfaceMeshFromModel(bracketActualMeshFixture);
    expect(surfaceMeshComponentCount(staticSurface)).toBe(1);
    expect(surfaceMeshComponentCount(dynamicSurface)).toBe(1);
    expect(staticResult.diagnostics.relativeResidual).toBeLessThan(1e-7);
    expect(dynamicResult.result.frames.length).toBeGreaterThan(1);
  });
});

function getNodeSet(model: OpenCAEModelJson, name: string): number[] {
  return model.nodeSets.find((nodeSet) => nodeSet.name === name)?.nodes ?? [];
}

function getSurfaceSet(model: OpenCAEModelJson, name: string): SurfaceSetJson {
  const surfaceSet = model.surfaceSets?.find((set) => set.name === name);
  if (!surfaceSet) throw new Error(`Missing surface set ${name}`);
  return surfaceSet;
}

function sumVectorDofs(values: Float64Array): [number, number, number] {
  const sum: [number, number, number] = [0, 0, 0];
  for (let index = 0; index < values.length; index += 3) {
    sum[0] += values[index];
    sum[1] += values[index + 1];
    sum[2] += values[index + 2];
  }
  return sum;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function maxAbs(values: Float64Array): number {
  let max = 0;
  for (const value of values) max = Math.max(max, Math.abs(value));
  return max;
}

function surfaceMeshComponentCount(surfaceMesh: SolverSurfaceMesh): number {
  const nodeAdjacency = new Map<number, Set<number>>();
  for (let node = 0; node < surfaceMesh.nodes.length; node += 1) {
    nodeAdjacency.set(node, new Set());
  }
  for (const triangle of surfaceMesh.triangles) {
    for (let index = 0; index < triangle.length; index += 1) {
      const a = triangle[index];
      const b = triangle[(index + 1) % triangle.length];
      nodeAdjacency.get(a)?.add(b);
      nodeAdjacency.get(b)?.add(a);
    }
  }

  let components = 0;
  const seen = new Set<number>();
  for (const node of nodeAdjacency.keys()) {
    if (seen.has(node)) continue;
    components += 1;
    const stack = [node];
    seen.add(node);
    while (stack.length > 0) {
      const current = stack.pop() ?? 0;
      for (const next of nodeAdjacency.get(current) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
  }
  return components;
}

function averageStressNearX(
  surfaceMesh: SolverSurfaceMesh,
  values: number[],
  x: number,
  tolerance: number
): number {
  const samples = surfaceMesh.nodes
    .map((node, index) => ({ node, value: values[index] ?? 0 }))
    .filter((entry) => Math.abs(entry.node[0] - x) <= tolerance);
  return mean(samples.map((entry) => entry.value));
}

function highStressSurfaceNodes(
  surfaceMesh: SolverSurfaceMesh,
  values: number[],
  thresholdFraction: number
): { node: [number, number, number]; value: number }[] {
  const max = Math.max(...values);
  const threshold = max * thresholdFraction;
  return surfaceMesh.nodes
    .map((node, index) => ({ node, value: values[index] ?? 0 }))
    .filter((entry) => entry.value >= threshold);
}

function uniqueRounded(values: number[], decimals: number): Set<number> {
  const scale = 10 ** decimals;
  return new Set(values.map((value) => Math.round(value * scale) / scale));
}

function isStressVisualizationDiagnostic(value: unknown): value is {
  engineeringStressMaxMpa: number;
  plotStressMinMpa: number;
  plotStressMaxMpa: number;
  stressFieldLocation: string;
  surfaceMeshRef: string;
  visualizationSource: string;
  stressRecoveryMethod: string;
  surfaceNodeCount: number;
  surfaceTriangleCount: number;
  stressFieldValueCount: number;
  displacementFieldValueCount: number;
  fieldSurfaceAlignment: string;
  fixedNodeCount: number;
  loadNodeCount: number;
  appliedLoadVector: [number, number, number];
  reactionVector: [number, number, number];
  fixedCentroid: [number, number, number];
  loadCentroid: [number, number, number];
  effectiveLeverArmMm: number;
  stressByBeamAxisBin: Array<{
    bin: number;
    axisCenter: number;
    meanStressMpa: number;
    maxStressMpa: number;
    nodeCount: number;
  }>;
  warnings: string[];
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    (value as { id?: unknown }).id === "stress-visualization" &&
    "stressRecoveryMethod" in value &&
    (
      (value as { stressRecoveryMethod?: unknown }).stressRecoveryMethod === "volume_weighted_nodal_recovery" ||
      (value as { stressRecoveryMethod?: unknown }).stressRecoveryMethod === "volume_weighted_nodal_recovery_laplacian_smoothed"
    )
  );
}

function isCoreSolveDiagnostic(value: unknown): value is {
  id: "core-solve-diagnostics";
  displayMaxStressMpa: number;
  displayMaxDisplacementMm: number;
  rawMaxStressPa: number;
  fieldSurfaceAlignment: string;
  solverMethod: string;
  warnings: string[];
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    (value as { id?: unknown }).id === "core-solve-diagnostics"
  );
}
