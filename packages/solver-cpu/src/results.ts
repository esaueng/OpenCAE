import {
  assembleNodalLoadVectorWithDiagnostics,
  assertProductionSurfaceFieldInvariant,
  connectedComponents,
  createCoreResultField,
  OPENCAE_CORE_VERSION,
  nodesPerElement,
  solverSurfaceMeshFromModel,
  validateProductionSurfaceFieldInvariant,
  type BoundaryConditionJson,
  type CoreResultField,
  type CoreModalSolveResult,
  type CoreSolveDiagnostics,
  type CoreSolveProvenance,
  type CoreStructuralSolveResult,
  type LoadJson,
  type NormalizedOpenCAEModel,
  type SolverSurfaceMesh
} from "@opencae/core";
import { computePrincipalStressMeasures, smoothNodalScalarField } from "./element";
import { recoverNodalStressTensorsFromElements, recoverNodalVonMisesFromElements } from "./recovery";
import type { DynamicTet4CpuResult, DynamicTet4CpuDiagnostics, ModalCpuDiagnostics, ModalCpuResult, StaticLinearTet4CpuResult, CpuSolverDiagnostics } from "./types";

export const SOLVER_CPU_VERSION = "0.1.5";

export function staticCoreResultFromSolve(
  model: NormalizedOpenCAEModel,
  result: StaticLinearTet4CpuResult,
  diagnostics: CpuSolverDiagnostics
): CoreStructuralSolveResult {
  const surfaceMesh = solverSurfaceMeshFromModel(model);
  const safetyFactor = computeSafetyFactor(model, result.vonMisesPeak ?? result.vonMises);
  const provenance = coreProvenance(model, "opencae-core-sparse-tet");
  const rawMaxDisplacement = maxNodeVectorNorm(result.displacement);
  const reactionForce = vectorSumMagnitude(result.reactionForce);
  const displacementScale = lengthToMmScale(model);
  const stressScale = stressToMpaScale(model);
  const recoveredNodalVonMises = result.nodalVonMises ?? recoverNodalVonMisesFromElements(model, result.vonMises);
  // Report the unaveraged element-peak von Mises: for Tet4 this is the centroid value
  // (legacy behavior); for Tet10 the in-element field is linear and node sampling
  // recovers the outer-fiber stress that centroid-only maxima clip on coarse meshes.
  const rawMaxStress = maxAbs(result.vonMisesPeak ?? result.vonMises);
  const displayMaxStress = rawMaxStress * stressScale;
  const displayMaxDisplacement = rawMaxDisplacement * displacementScale;
  const surfaceDisplacement = surfaceVectorMagnitudes(surfaceMesh, result.displacement, displacementScale);
  const surfaceDisplacementVectors = surfaceNodeVectors(surfaceMesh, result.displacement, displacementScale);
  const visualizationStress = visualizationStressValues(model, recoveredNodalVonMises, diagnostics.visualizationSmoothing);
  const surfaceVonMises = surfaceNodeScalars(
    surfaceMesh,
    visualizationStress.values,
    stressScale
  );
  const surfaceStressTensors = result.nodalStress
    ? surfaceNodeTensors(surfaceMesh, result.nodalStress, stressScale)
    : undefined;
  const displacementSurfaceField = createCoreResultField({
    id: "displacement-surface",
    type: "displacement",
    location: "node",
    values: surfaceDisplacement,
    vectors: surfaceDisplacementVectors,
    units: "mm",
    surfaceMeshRef: surfaceMesh.id,
    visualizationSource: "surface_displacement_vector"
  });
  const stressSurfaceField = createCoreResultField({
    id: "stress-surface",
    type: "stress",
    component: "von_mises",
    location: "node",
    values: surfaceVonMises,
    tensorValues: surfaceStressTensors,
    units: "MPa",
    surfaceMeshRef: surfaceMesh.id,
    visualizationSource: visualizationStress.source,
    engineeringSource: "raw_element_von_mises"
  });
  const fields: CoreResultField[] = [
    displacementSurfaceField,
    stressSurfaceField,
    ...principalStressSurfaceFields(model, surfaceMesh, result.stress, stressScale),
    createCoreResultField({
      id: "stress-von-mises-element",
      type: "stress",
      component: "von_mises",
      location: "element",
      values: scaleValues(result.vonMises, stressScale),
      units: "MPa",
      meshRef: "solver-volume",
      engineeringSource: "raw_element_von_mises"
    })
  ];
  if (hasYieldStrength(model)) {
    const nodalYield = recoverNodalVonMisesFromElements(model, elementYieldStrengths(model));
    fields.push(
      createCoreResultField({
        id: "safety-factor",
        type: "safety_factor",
        location: "element",
        values: safetyFactor,
        units: "ratio",
        meshRef: "solver-volume",
        engineeringSource: "raw_element_von_mises"
      }),
      createCoreResultField({
        id: "safety-factor-surface",
        type: "safety_factor",
        location: "node",
        values: surfaceNodeScalars(
          surfaceMesh,
          nodalSafetyFactorValues(nodalYield, visualizationStress.values),
          1
        ),
        units: "ratio",
        surfaceMeshRef: surfaceMesh.id,
        visualizationSource: "nodal_yield_over_recovered_von_mises",
        engineeringSource: "raw_element_von_mises"
      })
    );
  }

  const minSafetyFactor = positiveMin(safetyFactor);
  const stressDiagnostic = stressVisualizationDiagnostic(
    model,
    surfaceMesh,
    stressSurfaceField,
    displacementSurfaceField,
    result.reactionForce,
    displayMaxStress
  );
  const coreDiagnostics = coreSolveDiagnostics(
    model,
    provenance,
    surfaceMesh,
    stressDiagnostic,
    result.reactionForce,
    rawMaxStress,
    rawMaxDisplacement
  );
  const resultDiagnostics: unknown[] = [{ ...diagnostics }, coreDiagnostics, stressDiagnostic];
  if (rawMaxDisplacement === 0 && reactionForce > 1e-12) {
    resultDiagnostics.push({
      id: "zero-displacement-nonzero-load",
      severity: "warning",
      source: "solver",
      message: "Displacement is exactly zero even though the solved reaction force is nonzero."
    });
  }
  const coreResult: CoreStructuralSolveResult = {
    summary: {
      maxStress: displayMaxStress,
      maxStressUnits: "MPa",
      maxDisplacement: displayMaxDisplacement,
      maxDisplacementUnits: "mm",
      safetyFactor: minSafetyFactor,
      reactionForce,
      reactionForceUnits: "N",
      provenance
    },
    fields,
    surfaceMesh,
    diagnostics: resultDiagnostics,
    provenance,
    artifacts: {
      rawUnits: model.coordinateSystem.solverUnits,
      rawMaxStress,
      rawMaxDisplacement,
      rawElementVonMises: Array.from(result.vonMises)
    }
  };
  assertProductionSurfaceFieldInvariant(coreResult, { requireDisplacementVectors: true });
  return coreResult;
}

export function dynamicCoreResultFromSolve(
  model: NormalizedOpenCAEModel,
  result: DynamicTet4CpuResult,
  diagnostics: DynamicTet4CpuDiagnostics
): CoreStructuralSolveResult {
  const surfaceMesh = solverSurfaceMeshFromModel(model);
  const provenance = coreProvenance(model, "opencae-core-mdof-tet");
  const fields: CoreResultField[] = [];
  let latestSurfaceVonMises: number[] = [];
  let latestSurfaceDisplacement: number[] = [];
  let latestStressSurfaceField: CoreResultField | undefined;
  let latestDisplacementSurfaceField: CoreResultField | undefined;
  const displacementScale = lengthToMmScale(model);
  const stressScale = stressToMpaScale(model);
  const nodalYield = hasYieldStrength(model)
    ? recoverNodalVonMisesFromElements(model, elementYieldStrengths(model))
    : undefined;
  for (const frame of result.frames) {
    const surfaceDisplacement = surfaceVectorMagnitudes(surfaceMesh, frame.displacement.values, displacementScale);
    const surfaceDisplacementVectors = surfaceNodeVectors(surfaceMesh, frame.displacement.values, displacementScale);
    const surfaceVelocity = surfaceVectorMagnitudes(surfaceMesh, frame.velocity.values, displacementScale);
    const surfaceAcceleration = surfaceVectorMagnitudes(surfaceMesh, frame.acceleration.values, displacementScale);
    const recoveredNodalVonMises = frame.nodalVonMises?.values ?? recoverNodalVonMisesFromElements(model, frame.vonMises.values);
    const visualizationStress = visualizationStressValues(model, recoveredNodalVonMises, diagnostics.visualizationSmoothing);
    const surfaceVonMises = surfaceNodeScalars(
      surfaceMesh,
      visualizationStress.values,
      stressScale
    );
    const surfaceStressTensors = frame.nodalStress
      ? surfaceNodeTensors(surfaceMesh, frame.nodalStress.values, stressScale)
      : undefined;
    latestSurfaceVonMises = surfaceVonMises;
    latestSurfaceDisplacement = surfaceDisplacement;
    const displacementSurfaceField = createCoreResultField({
      id: `frame-${frame.frameIndex}-displacement-surface`,
      type: "displacement",
      location: "node",
      values: surfaceDisplacement,
      vectors: surfaceDisplacementVectors,
      units: "mm",
      surfaceMeshRef: surfaceMesh.id,
      frameIndex: frame.frameIndex,
      timeSeconds: frame.timeSeconds,
      visualizationSource: "surface_displacement_vector"
    });
    const stressSurfaceField = createCoreResultField({
      id: `frame-${frame.frameIndex}-stress-surface`,
      type: "stress",
      component: "von_mises",
      location: "node",
      values: surfaceVonMises,
      tensorValues: surfaceStressTensors,
      units: "MPa",
      surfaceMeshRef: surfaceMesh.id,
      frameIndex: frame.frameIndex,
      timeSeconds: frame.timeSeconds,
      visualizationSource: visualizationStress.source,
      engineeringSource: "raw_element_von_mises"
    });
    latestDisplacementSurfaceField = displacementSurfaceField;
    latestStressSurfaceField = stressSurfaceField;
    fields.push(
      displacementSurfaceField,
      createCoreResultField({
        id: `frame-${frame.frameIndex}-velocity`,
        type: "velocity",
        location: "node",
        values: surfaceVelocity,
        units: "mm/s",
        surfaceMeshRef: surfaceMesh.id,
        frameIndex: frame.frameIndex,
        timeSeconds: frame.timeSeconds,
        visualizationSource: "surface_velocity_magnitude"
      }),
      createCoreResultField({
        id: `frame-${frame.frameIndex}-acceleration`,
        type: "acceleration",
        location: "node",
        values: surfaceAcceleration,
        units: "mm/s^2",
        surfaceMeshRef: surfaceMesh.id,
        frameIndex: frame.frameIndex,
        timeSeconds: frame.timeSeconds,
        visualizationSource: "surface_acceleration_magnitude"
      }),
      stressSurfaceField,
      ...principalStressSurfaceFields(model, surfaceMesh, frame.stress.values, stressScale, {
        idPrefix: `frame-${frame.frameIndex}-`,
        frameIndex: frame.frameIndex,
        timeSeconds: frame.timeSeconds
      }),
      createCoreResultField({
        id: `frame-${frame.frameIndex}-stress-von-mises-element`,
        type: "stress",
        component: "von_mises",
        location: "element",
        values: scaleValues(frame.vonMises.values, stressScale),
        units: "MPa",
        meshRef: "solver-volume",
        frameIndex: frame.frameIndex,
        timeSeconds: frame.timeSeconds,
        engineeringSource: "raw_element_von_mises"
      })
    );
    if (nodalYield !== undefined) {
      fields.push(
        createCoreResultField({
          id: `frame-${frame.frameIndex}-safety-factor`,
          type: "safety_factor",
          location: "element",
          values: frame.safety_factor.values,
          units: "ratio",
          meshRef: "solver-volume",
          frameIndex: frame.frameIndex,
          timeSeconds: frame.timeSeconds,
          engineeringSource: "raw_element_von_mises"
        }),
        createCoreResultField({
          id: `frame-${frame.frameIndex}-safety-factor-surface`,
          type: "safety_factor",
          location: "node",
          values: surfaceNodeScalars(
            surfaceMesh,
            nodalSafetyFactorValues(nodalYield, visualizationStress.values),
            1
          ),
          units: "ratio",
          surfaceMeshRef: surfaceMesh.id,
          frameIndex: frame.frameIndex,
          timeSeconds: frame.timeSeconds,
          visualizationSource: "nodal_yield_over_recovered_von_mises",
          engineeringSource: "raw_element_von_mises"
        })
      );
    }
  }

  const latestReactionForce = result.frames.at(-1)?.reactionForce;
  const rawMaxDisplacement = diagnostics.peakDisplacement;
  const rawMaxStress = diagnostics.maxVonMisesStress;
  const displayMaxStress = rawMaxStress * stressScale;
  const displayMaxDisplacement = rawMaxDisplacement * displacementScale;
  const stressDiagnostic = stressVisualizationDiagnostic(
    model,
    surfaceMesh,
    latestStressSurfaceField ?? createCoreResultField({
      id: "stress-surface-empty",
      type: "stress",
      component: "von_mises",
      location: "node",
      values: latestSurfaceVonMises,
      units: "MPa",
      surfaceMeshRef: surfaceMesh.id,
      visualizationSource: diagnostics.visualizationSmoothing && (diagnostics.visualizationSmoothing.iterations ?? 0) > 0 && (diagnostics.visualizationSmoothing.alpha ?? 0) > 0
        ? "volume_weighted_nodal_recovery_laplacian_smoothed"
        : "volume_weighted_nodal_recovery",
      engineeringSource: "raw_element_von_mises"
    }),
    latestDisplacementSurfaceField ?? createCoreResultField({
      id: "displacement-surface-empty",
      type: "displacement",
      location: "node",
      values: latestSurfaceDisplacement,
      units: "mm",
      surfaceMeshRef: surfaceMesh.id,
      visualizationSource: "surface_displacement_vector"
    }),
    latestReactionForce,
    displayMaxStress
  );

  const coreResult: CoreStructuralSolveResult = {
    summary: {
      maxStress: displayMaxStress,
      maxStressUnits: "MPa",
      maxDisplacement: displayMaxDisplacement,
      maxDisplacementUnits: "mm",
      safetyFactor: diagnostics.minSafetyFactor,
      reactionForce: result.frames.length > 0 ? vectorSumMagnitude(latestReactionForce) : 0,
      reactionForceUnits: "N",
      provenance,
      transient: {
        frameCount: diagnostics.frameCount,
        analysisType: "dynamic_structural",
        integrationMethod: "newmark_average_acceleration",
        dampingRatio: diagnostics.dampingRatio,
        startTime: diagnostics.startTime,
        endTime: diagnostics.endTime,
        timeStep: diagnostics.timeStep,
        outputInterval: diagnostics.outputInterval,
        loadProfile: diagnostics.loadProfile,
        peakDisplacement: displayMaxDisplacement,
        peakDisplacementTimeSeconds: peakDisplacementTime(result),
        peakVelocity: diagnostics.peakVelocity * displacementScale,
        peakAcceleration: diagnostics.peakAcceleration * displacementScale
      }
    },
    fields,
    surfaceMesh,
    diagnostics: [
      { ...diagnostics },
      coreSolveDiagnostics(model, provenance, surfaceMesh, stressDiagnostic, latestReactionForce, rawMaxStress, rawMaxDisplacement),
      stressDiagnostic
    ],
    provenance,
    artifacts: {
      rawUnits: model.coordinateSystem.solverUnits,
      rawMaxStress,
      rawMaxDisplacement
    }
  };
  if (latestStressSurfaceField && latestDisplacementSurfaceField) {
    assertProductionSurfaceFieldInvariant(coreResult, {
      stressFieldId: latestStressSurfaceField.id,
      displacementFieldId: latestDisplacementSurfaceField.id,
      requireDisplacementVectors: true
    });
  }
  return coreResult;
}

function principalStressSurfaceFields(
  model: NormalizedOpenCAEModel,
  surfaceMesh: SolverSurfaceMesh,
  elementStress: ArrayLike<number>,
  stressScale: number,
  metadata: { idPrefix?: string; frameIndex?: number; timeSeconds?: number } = {}
): CoreResultField[] {
  const nodalStress = recoverNodalStressTensorsFromElements(model, elementStress);
  const principalMax = new Float64Array(model.counts.nodes);
  const principalMin = new Float64Array(model.counts.nodes);
  const maxShear = new Float64Array(model.counts.nodes);
  for (let node = 0; node < model.counts.nodes; node += 1) {
    const measures = computePrincipalStressMeasures(nodalStress.subarray(node * 6, node * 6 + 6));
    principalMax[node] = measures.principalMax;
    principalMin[node] = measures.principalMin;
    maxShear[node] = measures.maxShear;
  }
  const shared = {
    type: "stress" as const,
    location: "node" as const,
    units: "MPa",
    surfaceMeshRef: surfaceMesh.id,
    visualizationSource: "volume_weighted_recovered_stress_tensor",
    engineeringSource: "combined_or_recovered_stress_tensor",
    ...(metadata.frameIndex !== undefined ? { frameIndex: metadata.frameIndex } : {}),
    ...(metadata.timeSeconds !== undefined ? { timeSeconds: metadata.timeSeconds } : {})
  };
  const idPrefix = metadata.idPrefix ?? "";
  return [
    createCoreResultField({ ...shared, id: `${idPrefix}stress-principal-max-surface`, component: "principal_max", values: surfaceNodeScalars(surfaceMesh, principalMax, stressScale) }),
    createCoreResultField({ ...shared, id: `${idPrefix}stress-principal-min-surface`, component: "principal_min", values: surfaceNodeScalars(surfaceMesh, principalMin, stressScale) }),
    createCoreResultField({ ...shared, id: `${idPrefix}stress-max-shear-surface`, component: "max_shear", values: surfaceNodeScalars(surfaceMesh, maxShear, stressScale) })
  ];
}

export function modalCoreResultFromSolve(
  model: NormalizedOpenCAEModel,
  result: Pick<ModalCpuResult, "modes">,
  diagnostics: ModalCpuDiagnostics
): CoreModalSolveResult {
  const surfaceMesh = solverSurfaceMeshFromModel(model);
  const provenance = coreProvenance(model, "opencae-core-modal-tet");
  const fields = result.modes.map((mode) => createCoreResultField({
    id: `mode-${mode.modeIndex}-shape`,
    type: "mode_shape" as const,
    location: "node" as const,
    values: surfaceVectorMagnitudes(surfaceMesh, mode.shape, 1),
    vectors: surfaceNodeVectors(surfaceMesh, mode.shape, 1),
    units: "normalized",
    surfaceMeshRef: surfaceMesh.id,
    modeIndex: mode.modeIndex,
    frequencyHz: mode.frequencyHz,
    eigenvalue: mode.eigenvalue,
    scaledResidual: mode.scaledResidual,
    visualizationSource: "normalized_modal_eigenvector"
  }));
  return {
    analysisType: "modal_analysis",
    summary: {
      analysisType: "modal_analysis",
      requestedModeCount: diagnostics.requestedModeCount,
      convergedModeCount: result.modes.length,
      modes: result.modes.map((mode) => ({
        modeIndex: mode.modeIndex,
        frequencyHz: mode.frequencyHz,
        eigenvalue: mode.eigenvalue,
        scaledResidual: mode.scaledResidual,
        fieldId: `mode-${mode.modeIndex}-shape`
      })),
      ...(diagnostics.partialConvergenceWarning ? { warning: diagnostics.partialConvergenceWarning } : {}),
      provenance
    },
    fields,
    surfaceMesh,
    diagnostics: [{ id: "modal-solve-diagnostics", ...diagnostics }],
    provenance,
    artifacts: { rawUnits: model.coordinateSystem.solverUnits }
  };
}

function computeSafetyFactor(model: NormalizedOpenCAEModel, vonMises: Float64Array): Float64Array {
  const values = new Float64Array(vonMises.length);
  let element = 0;
  for (const block of model.elementBlocks) {
    const yieldStrength = model.materials[block.materialIndex]?.yieldStrength ?? 0;
    const elementNodeCount = block.type === "Tet10" ? 10 : 4;
    const elementCount = Math.floor(block.connectivity.length / elementNodeCount);
    for (let index = 0; index < elementCount; index += 1) {
      values[element] = yieldStrength > 0 && vonMises[element] > 0 ? yieldStrength / vonMises[element] : 0;
      element += 1;
    }
  }
  return values;
}

function hasYieldStrength(model: NormalizedOpenCAEModel): boolean {
  return model.materials.some((material) => (material.yieldStrength ?? 0) > 0);
}

function elementYieldStrengths(model: NormalizedOpenCAEModel): Float64Array {
  const values = new Float64Array(model.counts.elements);
  let element = 0;
  for (const block of model.elementBlocks) {
    const yieldStrength = model.materials[block.materialIndex]?.yieldStrength ?? 0;
    const elementNodeCount = block.type === "Tet10" ? 10 : 4;
    const elementCount = Math.floor(block.connectivity.length / elementNodeCount);
    for (let index = 0; index < elementCount; index += 1) {
      values[element] = yieldStrength;
      element += 1;
    }
  }
  return values;
}

// Display clamp for the node-located safety-factor contour fields, matching the web
// viewer's derived-field convention (clampSafetyFactor in the OpenCAE web app): the
// viewer's palette is linear and anchored at field.min, so an unstressed node must map
// to the CAP (safest), never to 0 (which would render as the most critical color and
// squash the real safety-factor range).
export const SAFETY_FACTOR_DISPLAY_CAP = 10000;
export const SAFETY_FACTOR_DISPLAY_FLOOR = 0.01;

// Nodal safety factor for contour rendering: volume-weighted nodal yield strength over
// the SAME recovered/smoothed nodal von Mises used for the stress-surface field, so the
// two contours stay consistent. Nodes where the ratio is undefined or unbounded — zero
// recovered stress (e.g. an unloaded/disconnected body, or frame 0 of a ramp load) or no
// recovered yield limit — clamp to SAFETY_FACTOR_DISPLAY_CAP, i.e. render as SAFEST.
// This intentionally differs from the element-field convention (0 = undefined): the
// element field feeds the positive-min summary, while this field feeds a linear
// min-anchored color palette where 0 reads as the most critical value.
// Exported for tests.
export function nodalSafetyFactorValues(nodalYield: Float64Array, nodalVonMises: Float64Array): Float64Array {
  const values = new Float64Array(nodalVonMises.length);
  for (let node = 0; node < values.length; node += 1) {
    const yieldStrength = nodalYield[node];
    const vonMises = nodalVonMises[node];
    if (!(yieldStrength > 0) || !(vonMises > 0)) {
      values[node] = SAFETY_FACTOR_DISPLAY_CAP;
      continue;
    }
    const ratio = yieldStrength / vonMises;
    values[node] = Math.min(SAFETY_FACTOR_DISPLAY_CAP, Math.max(SAFETY_FACTOR_DISPLAY_FLOOR, ratio));
  }
  return values;
}

function coreProvenance(
  model: NormalizedOpenCAEModel,
  solver: CoreSolveProvenance["solver"]
): CoreSolveProvenance {
  const meshSource = model.meshProvenance?.meshSource;
  return {
    kind: "opencae_core_fea",
    solver,
    resultSource: "computed",
    meshSource:
      meshSource === "structured_block_core"
        ? "structured_block_core"
        : "actual_volume_mesh",
    units: "mm-N-s-MPa",
    coreVersion: OPENCAE_CORE_VERSION,
    solverCpuVersion: SOLVER_CPU_VERSION
  };
}

function peakDisplacementTime(result: DynamicTet4CpuResult): number {
  let peak = -1;
  let time = 0;
  for (const frame of result.frames) {
    const value = maxNodeVectorNorm(frame.displacement.values);
    if (value > peak) {
      peak = value;
      time = frame.timeSeconds;
    }
  }
  return time;
}

function maxNodeVectorNorm(values: Float64Array): number {
  let max = 0;
  for (let node = 0; node < values.length / 3; node += 1) {
    max = Math.max(max, Math.hypot(values[node * 3], values[node * 3 + 1], values[node * 3 + 2]));
  }
  return max;
}

function stressToMpaScale(model: NormalizedOpenCAEModel): number {
  return model.coordinateSystem.solverUnits === "mm-N-s-MPa" ? 1 : 1 / 1_000_000;
}

function stressToPaScale(model: NormalizedOpenCAEModel): number {
  return model.coordinateSystem.solverUnits === "mm-N-s-MPa" ? 1_000_000 : 1;
}

function scaleValues(values: ArrayLike<number>, scale: number): number[] {
  return Array.from(values, (value) => value * scale);
}

function visualizationStressValues(
  model: NormalizedOpenCAEModel,
  recoveredNodalVonMises: Float64Array,
  smoothing: CpuSolverDiagnostics["visualizationSmoothing"]
): { values: Float64Array; source: string } {
  const iterations = Math.max(0, Math.floor(smoothing?.iterations ?? 0));
  const alpha = Math.max(0, Math.min(1, smoothing?.alpha ?? 0));
  if (iterations <= 0 || alpha <= 0) {
    return { values: recoveredNodalVonMises, source: "volume_weighted_nodal_recovery" };
  }

  let current = Float64Array.from(recoveredNodalVonMises);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const averaged = smoothNodalScalarField(model, current, 1);
    const next = new Float64Array(current.length);
    for (let index = 0; index < current.length; index += 1) {
      next[index] = (1 - alpha) * current[index] + alpha * averaged[index];
    }
    current = next;
  }
  return { values: current, source: "volume_weighted_nodal_recovery_laplacian_smoothed" };
}

function surfaceVectorMagnitudes(surfaceMesh: SolverSurfaceMesh, vector: Float64Array, scale: number): number[] {
  return surfaceMesh.nodeMap.map((volumeNode, surfaceNode) => {
    const [x, y, z] = vectorComponentsForVolumeNode(vector, volumeNode, surfaceNode, "vector");
    return Math.hypot(x, y, z) * scale;
  });
}

function surfaceNodeVectors(
  surfaceMesh: SolverSurfaceMesh,
  vector: Float64Array,
  scale: number
): [number, number, number][] {
  return surfaceMesh.nodeMap.map((volumeNode, surfaceNode) => {
    const [x, y, z] = vectorComponentsForVolumeNode(vector, volumeNode, surfaceNode, "vector");
    return [
      x * scale,
      y * scale,
      z * scale
    ];
  });
}

function surfaceNodeScalars(surfaceMesh: SolverSurfaceMesh, nodalValues: Float64Array, scale: number): number[] {
  return surfaceMesh.nodeMap.map((volumeNode, surfaceNode) => {
    assertValidSurfaceVolumeNode(surfaceMesh, volumeNode, surfaceNode);
    const value = nodalValues[volumeNode];
    if (!Number.isFinite(value)) {
      throw new Error(`Surface scalar field cannot read volume node ${volumeNode} for surface node ${surfaceNode}.`);
    }
    return value * scale;
  });
}

function surfaceNodeTensors(surfaceMesh: SolverSurfaceMesh, nodalValues: Float64Array, scale: number): number[] {
  const values = new Array<number>(surfaceMesh.nodeMap.length * 6);
  surfaceMesh.nodeMap.forEach((volumeNode, surfaceNode) => {
    assertValidSurfaceVolumeNode(surfaceMesh, volumeNode, surfaceNode);
    for (let component = 0; component < 6; component += 1) {
      const value = nodalValues[volumeNode * 6 + component];
      if (!Number.isFinite(value)) {
        throw new Error(`Surface stress tensor cannot read volume node ${volumeNode}, component ${component}.`);
      }
      values[surfaceNode * 6 + component] = value * scale;
    }
  });
  return values;
}

function vectorComponentsForVolumeNode(
  vector: Float64Array,
  volumeNode: number,
  surfaceNode: number,
  fieldName: string
): [number, number, number] {
  if (!Number.isInteger(volumeNode) || volumeNode < 0) {
    throw new Error(`Surface ${fieldName} field references invalid volume node ${volumeNode} for surface node ${surfaceNode}.`);
  }
  const offset = volumeNode * 3;
  if (offset + 2 >= vector.length) {
    throw new Error(`Surface ${fieldName} field cannot read volume node ${volumeNode} for surface node ${surfaceNode}.`);
  }
  const components: [number, number, number] = [vector[offset], vector[offset + 1], vector[offset + 2]];
  if (!components.every(Number.isFinite)) {
    throw new Error(`Surface ${fieldName} field read non-finite vector components for volume node ${volumeNode}.`);
  }
  return components;
}

function assertValidSurfaceVolumeNode(surfaceMesh: SolverSurfaceMesh, volumeNode: number, surfaceNode: number): void {
  const volumeNodeCount = surfaceMesh.volumeNodeCount;
  if (
    !Number.isInteger(volumeNode) ||
    volumeNode < 0 ||
    (volumeNodeCount !== undefined && volumeNode >= volumeNodeCount)
  ) {
    throw new Error(`Surface field references invalid volume node ${volumeNode} for surface node ${surfaceNode}.`);
  }
}

type NodeSelectionSummary = {
  count: number;
  centroid: [number, number, number];
};

type StressBeamAxisBin = {
  bin: number;
  axisCenter: number;
  meanStressMpa: number;
  maxStressMpa: number;
  nodeCount: number;
};

function stressVisualizationDiagnostic(
  model: NormalizedOpenCAEModel,
  surfaceMesh: SolverSurfaceMesh,
  stressField: CoreResultField,
  displacementField: CoreResultField,
  reactionForce: Float64Array | undefined,
  engineeringStressMaxMpa: number
): {
  id: "stress-visualization";
  engineeringStressMaxMpa: number;
  plotStressMinMpa: number;
  plotStressMaxMpa: number;
  stressFieldLocation: CoreResultField["location"];
  surfaceMeshRef: string | undefined;
  visualizationSource: string | undefined;
  stressRecoveryMethod: "volume_weighted_nodal_recovery" | "volume_weighted_nodal_recovery_laplacian_smoothed";
  surfaceNodeCount: number;
  surfaceTriangleCount: number;
  stressFieldValueCount: number;
  displacementFieldValueCount: number;
  fieldSurfaceAlignment: "ok" | "invalid";
  fixedNodeCount: number;
  loadNodeCount: number;
  appliedLoadVector: [number, number, number];
  reactionVector: [number, number, number];
  fixedCentroid: [number, number, number];
  loadCentroid: [number, number, number];
  effectiveLeverArmMm: number;
  stressByBeamAxisBin: StressBeamAxisBin[];
  warnings: string[];
} {
  const activeStep = firstStructuralStep(model);
  const fixedSelection = nodeSelectionForBoundaryConditions(model, activeStep?.boundaryConditions ?? []);
  const loadSelection = nodeSelectionForLoads(model, activeStep?.loads ?? []);
  const stressByBeamAxisBin = stressBinsByBeamAxis(model, surfaceMesh, stressField.values, 20);
  const warnings = stressVisualizationWarnings(model, stressByBeamAxisBin, fixedSelection, loadSelection);
  const alignment = validateProductionSurfaceFieldInvariant(
    {
      surfaceMesh,
      fields: [stressField, displacementField]
    },
    {
      stressFieldId: stressField.id,
      displacementFieldId: displacementField.id
    }
  ).ok
    ? "ok"
    : "invalid";
  return {
    id: "stress-visualization",
    engineeringStressMaxMpa,
    plotStressMinMpa: stressField.values.length > 0 ? Math.min(...stressField.values) : 0,
    plotStressMaxMpa: stressField.values.length > 0 ? Math.max(...stressField.values) : 0,
    stressFieldLocation: stressField.location,
    surfaceMeshRef: stressField.surfaceMeshRef,
    visualizationSource: stressField.visualizationSource,
    stressRecoveryMethod:
      stressField.visualizationSource === "volume_weighted_nodal_recovery_laplacian_smoothed"
        ? "volume_weighted_nodal_recovery_laplacian_smoothed"
        : "volume_weighted_nodal_recovery",
    surfaceNodeCount: surfaceMesh.nodes.length,
    surfaceTriangleCount: surfaceMesh.triangles.length,
    stressFieldValueCount: stressField.values.length,
    displacementFieldValueCount: displacementField.values.length,
    fieldSurfaceAlignment: alignment,
    fixedNodeCount: fixedSelection.count,
    loadNodeCount: loadSelection.count,
    appliedLoadVector: activeStep ? appliedLoadVectorForStep(model, activeStep.loads) : [0, 0, 0],
    reactionVector: vectorSum(reactionForce),
    fixedCentroid: fixedSelection.centroid,
    loadCentroid: loadSelection.centroid,
    effectiveLeverArmMm: distance(fixedSelection.centroid, loadSelection.centroid) * lengthToMmScale(model),
    stressByBeamAxisBin,
    warnings
  };
}

function coreSolveDiagnostics(
  model: NormalizedOpenCAEModel,
  provenance: CoreSolveProvenance,
  surfaceMesh: SolverSurfaceMesh,
  stressDiagnostic: ReturnType<typeof stressVisualizationDiagnostic>,
  reactionForce: Float64Array | undefined,
  rawMaxStress: number,
  rawMaxDisplacement: number
): CoreSolveDiagnostics {
  const reactionVector = vectorSum(reactionForce);
  const displayMaxStressMpa = rawMaxStress * stressToMpaScale(model);
  const displayMaxDisplacementMm = rawMaxDisplacement * lengthToMmScale(model);
  return {
    id: "core-solve-diagnostics",
    coreModelSchemaVersion: model.schemaVersion,
    coreVersion: provenance.coreVersion,
    solverCpuVersion: provenance.solverCpuVersion,
    solverMethod: provenance.solver,
    meshSource: provenance.meshSource,
    nodeCount: model.counts.nodes,
    elementCount: model.counts.elements,
    surfaceNodeCount: surfaceMesh.nodes.length,
    surfaceTriangleCount: surfaceMesh.triangles.length,
    connectedComponentCount: connectedComponents({
      elementBlocks: model.elementBlocks.map((block) => ({
        name: block.name,
        type: block.type,
        material: block.material,
        connectivity: Array.from(block.connectivity)
      }))
    }).componentCount,
    fixedNodeCount: stressDiagnostic.fixedNodeCount,
    loadNodeCount: stressDiagnostic.loadNodeCount,
    fixedCentroid: stressDiagnostic.fixedCentroid,
    loadCentroid: stressDiagnostic.loadCentroid,
    effectiveLeverArmMm: stressDiagnostic.effectiveLeverArmMm,
    totalLoadVectorN: stressDiagnostic.appliedLoadVector,
    reactionVectorN: reactionVector,
    reactionMagnitudeN: Math.hypot(reactionVector[0], reactionVector[1], reactionVector[2]),
    rawMaxStressPa: rawMaxStress * stressToPaScale(model),
    displayMaxStressMpa,
    rawMaxDisplacementM: rawMaxDisplacement * lengthToMScale(model),
    displayMaxDisplacementMm,
    engineeringStressMaxMpa: displayMaxStressMpa,
    plotStressMinMpa: stressDiagnostic.plotStressMinMpa,
    plotStressMaxMpa: stressDiagnostic.plotStressMaxMpa,
    stressRecoveryMethod: stressDiagnostic.stressRecoveryMethod,
    fieldSurfaceAlignment: stressDiagnostic.fieldSurfaceAlignment,
    stressFieldValueCount: stressDiagnostic.stressFieldValueCount,
    displacementFieldValueCount: stressDiagnostic.displacementFieldValueCount,
    warnings: stressDiagnostic.warnings,
    stressByBeamAxisBin: stressDiagnostic.stressByBeamAxisBin
  };
}

function firstStructuralStep(model: NormalizedOpenCAEModel): { boundaryConditions: string[]; loads: string[] } | undefined {
  return model.steps.find((step) => step.type === "staticLinear" || step.type === "dynamicLinear");
}

function nodeSelectionForBoundaryConditions(model: NormalizedOpenCAEModel, boundaryConditionNames: string[]): NodeSelectionSummary {
  const active = new Set(boundaryConditionNames);
  const nodeIds = new Set<number>();
  const facetById = new Map(model.surfaceFacets.map((facet) => [facet.id, facet]));
  const surfaceSetByName = new Map(model.surfaceSets.map((set) => [set.name, set]));
  for (const boundaryCondition of model.boundaryConditions) {
    if (active.has(boundaryCondition.name) && isFixedBoundaryCondition(boundaryCondition)) {
      if ("surfaceSet" in boundaryCondition && boundaryCondition.surfaceSet) {
        const surfaceSet = surfaceSetByName.get(boundaryCondition.surfaceSet);
        for (const facetId of surfaceSet?.facets ?? []) {
          for (const node of facetById.get(facetId)?.nodes ?? []) nodeIds.add(node);
        }
      } else if ("nodeSet" in boundaryCondition && boundaryCondition.nodeSet) {
        addNodeSetNodes(model, boundaryCondition.nodeSet, nodeIds);
      }
    }
  }
  return nodeSelectionSummary(model, nodeIds);
}

function nodeSelectionForLoads(model: NormalizedOpenCAEModel, loadNames: string[]): NodeSelectionSummary {
  const active = new Set(loadNames);
  const nodeIds = new Set<number>();
  for (const load of model.loads) {
    if (!active.has(load.name)) continue;
    addLoadNodes(model, load, nodeIds);
  }
  return nodeSelectionSummary(model, nodeIds);
}

function addLoadNodes(model: NormalizedOpenCAEModel, load: LoadJson, nodeIds: Set<number>): void {
  if (load.type === "nodalForce") {
    addNodeSetNodes(model, load.nodeSet, nodeIds);
    return;
  }
  if (load.type === "surfaceForce" || load.type === "pressure" || load.type === "surfaceTraction" || load.type === "remoteForce") {
    addSurfaceSetNodes(model, load.surfaceSet, nodeIds);
    return;
  }
  if (load.type === "equivalentBoltPreload") {
    addSurfaceSetNodes(model, load.surfaceSetA, nodeIds);
    addSurfaceSetNodes(model, load.surfaceSetB, nodeIds);
    return;
  }
  if (load.type === "bodyForceDensity") {
    const selected = new Set(model.elementSets.find((set) => set.name === load.elementSet)?.elements ?? []);
    let globalElement = 0;
    for (const block of model.elementBlocks) {
      const count = nodesPerElement(block.type);
      for (let offset = 0; offset + count <= block.connectivity.length; offset += count, globalElement += 1) {
        if (!selected.has(globalElement)) continue;
        for (let local = 0; local < count; local += 1) nodeIds.add(block.connectivity[offset + local]!);
      }
    }
    return;
  }
  if (load.type === "bodyGravity") {
    for (let node = 0; node < model.counts.nodes; node += 1) nodeIds.add(node);
  }
}

function addSurfaceSetNodes(model: NormalizedOpenCAEModel, surfaceSetName: string, nodeIds: Set<number>): void {
  const surfaceSet = model.surfaceSets.find((set) => set.name === surfaceSetName);
  if (!surfaceSet) return;
  const facetById = new Map(model.surfaceFacets.map((facet) => [facet.id, facet]));
  for (const facetId of surfaceSet.facets) {
    const facet = facetById.get(facetId);
    if (!facet) continue;
    for (const node of facet.nodes) nodeIds.add(node);
  }
}

function addNodeSetNodes(model: NormalizedOpenCAEModel, nodeSetName: string, nodeIds: Set<number>): void {
  const nodeSet = model.nodeSets.find((candidate) => candidate.name === nodeSetName);
  if (!nodeSet) return;
  for (const node of nodeSet.nodes) nodeIds.add(node);
}

function nodeSelectionSummary(model: NormalizedOpenCAEModel, nodeIds: Set<number>): NodeSelectionSummary {
  if (nodeIds.size === 0) {
    return { count: 0, centroid: [0, 0, 0] };
  }
  let x = 0;
  let y = 0;
  let z = 0;
  for (const node of nodeIds) {
    x += modelCoordinateAt(model, node, 0);
    y += modelCoordinateAt(model, node, 1);
    z += modelCoordinateAt(model, node, 2);
  }
  return { count: nodeIds.size, centroid: [x / nodeIds.size, y / nodeIds.size, z / nodeIds.size] };
}

function isFixedBoundaryCondition(boundaryCondition: BoundaryConditionJson): boolean {
  return boundaryCondition.type === "fixed";
}

function appliedLoadVectorForStep(model: NormalizedOpenCAEModel, loadNames: string[]): [number, number, number] {
  return assembleNodalLoadVectorWithDiagnostics(model, loadNames).diagnostics.totalAppliedForce;
}

function stressBinsByBeamAxis(
  model: NormalizedOpenCAEModel,
  surfaceMesh: SolverSurfaceMesh,
  values: number[],
  binCount: number
): StressBeamAxisBin[] {
  const bounds = modelBounds(model);
  const axis = dominantBoundsAxis(bounds);
  const min = bounds.min[axis];
  const max = bounds.max[axis];
  const span = max - min;
  const count = Math.max(1, Math.floor(binCount));
  const bins = Array.from({ length: count }, (_value, bin) => ({
    bin,
    axisCenter: span > 0 ? min + ((bin + 0.5) / count) * span : min,
    sum: 0,
    maxStressMpa: Number.NEGATIVE_INFINITY,
    nodeCount: 0
  }));

  for (let index = 0; index < surfaceMesh.nodes.length; index += 1) {
    const node = surfaceMesh.nodes[index];
    const value = values[index];
    if (!node || !Number.isFinite(value)) continue;
    const station = span > 0 ? (node[axis] - min) / span : 0;
    const bin = Math.max(0, Math.min(count - 1, Math.floor(station * count)));
    const target = bins[bin];
    target.sum += value;
    target.maxStressMpa = Math.max(target.maxStressMpa, value);
    target.nodeCount += 1;
  }

  return bins.map((bin) => ({
    bin: bin.bin,
    axisCenter: bin.axisCenter,
    meanStressMpa: bin.nodeCount > 0 ? bin.sum / bin.nodeCount : 0,
    maxStressMpa: bin.nodeCount > 0 ? bin.maxStressMpa : 0,
    nodeCount: bin.nodeCount
  }));
}

function stressVisualizationWarnings(
  model: NormalizedOpenCAEModel,
  bins: StressBeamAxisBin[],
  fixedSelection: NodeSelectionSummary,
  loadSelection: NodeSelectionSummary
): string[] {
  const warnings: string[] = [];
  if (hasAbruptStressDiscontinuity(bins)) {
    warnings.push("Stress field has abrupt spatial discontinuity; verify surface node mapping, load/support mapping, or stress recovery.");
  }
  if (loadSupportMappingLooksSuspicious(model, fixedSelection, loadSelection)) {
    warnings.push("Load/support mapping does not match expected end-face selection.");
  }
  return warnings;
}

export function hasAbruptStressDiscontinuity(bins: StressBeamAxisBin[]): boolean {
  const populated = bins.filter((bin) => bin.nodeCount > 0);
  if (populated.length < 6) return false;
  const means = populated.map((bin) => bin.meanStressMpa);
  const min = Math.min(...means);
  const max = Math.max(...means);
  const range = max - min;
  if (!Number.isFinite(range) || range <= 1e-9) return false;
  let largestJump = 0;
  let largestJumpIndex = -1;
  const jumps: number[] = [];
  for (let index = 1; index < means.length; index += 1) {
    const jump = Math.abs(means[index] - means[index - 1]);
    jumps.push(jump);
    if (jump > largestJump) {
      largestJump = jump;
      largestJumpIndex = index;
    }
  }
  if (largestJump / range < 0.7 || largestJumpIndex <= 0) return false;
  const sortedJumps = [...jumps].sort((left, right) => right - left);
  const secondLargestJump = sortedJumps[1] ?? 0;
  const left = means.slice(0, largestJumpIndex);
  const right = means.slice(largestJumpIndex);
  if (left.length < 2 || right.length < 2) return false;
  const leftSpread = Math.max(...left) - Math.min(...left);
  const rightSpread = Math.max(...right) - Math.min(...right);
  const mostlyFlatZones = leftSpread <= range * 0.25 && rightSpread <= range * 0.25;
  const dominantSingleJump = secondLargestJump <= largestJump * 0.35;
  return mostlyFlatZones || dominantSingleJump;
}

function loadSupportMappingLooksSuspicious(
  model: NormalizedOpenCAEModel,
  fixedSelection: NodeSelectionSummary,
  loadSelection: NodeSelectionSummary
): boolean {
  if (fixedSelection.count === 0 || loadSelection.count === 0) return false;
  const bounds = modelBounds(model);
  const axis = dominantBoundsAxis(bounds);
  const min = bounds.min[axis];
  const max = bounds.max[axis];
  const span = max - min;
  if (!Number.isFinite(span) || span <= 1e-12) return false;
  const fixedStation = fixedSelection.centroid[axis];
  const loadStation = loadSelection.centroid[axis];
  if (Math.abs(loadStation - fixedStation) < span * 0.4) return true;
  const fixedEndDistance = Math.min(Math.abs(fixedStation - min), Math.abs(fixedStation - max));
  const loadEndDistance = Math.min(Math.abs(loadStation - min), Math.abs(loadStation - max));
  return fixedEndDistance > span * 0.25 || loadEndDistance > span * 0.25;
}

function modelBounds(model: NormalizedOpenCAEModel): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max: [number, number, number] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let node = 0; node < model.counts.nodes; node += 1) {
    for (const axis of [0, 1, 2] as const) {
      const coordinate = modelCoordinateAt(model, node, axis);
      min[axis] = Math.min(min[axis], coordinate);
      max[axis] = Math.max(max[axis], coordinate);
    }
  }
  return { min, max };
}

function dominantBoundsAxis(bounds: { min: [number, number, number]; max: [number, number, number] }): 0 | 1 | 2 {
  const spans: [number, number, number] = [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2]
  ];
  return spans[0] >= spans[1] && spans[0] >= spans[2] ? 0 : spans[1] >= spans[2] ? 1 : 2;
}

function modelCoordinateAt(model: NormalizedOpenCAEModel, node: number, axis: 0 | 1 | 2): number {
  const value = model.nodes.coordinates[node * 3 + axis];
  if (!Number.isFinite(value)) {
    throw new Error(`Model node ${node} has non-finite coordinate ${axis}.`);
  }
  return value;
}

function distance(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function lengthToMmScale(model: NormalizedOpenCAEModel): number {
  return model.coordinateSystem.solverUnits === "mm-N-s-MPa" ? 1 : 1000;
}

function lengthToMScale(model: NormalizedOpenCAEModel): number {
  return model.coordinateSystem.solverUnits === "mm-N-s-MPa" ? 1 / 1000 : 1;
}

function maxAbs(values: Float64Array): number {
  let max = 0;
  for (const value of values) max = Math.max(max, Math.abs(value));
  return max;
}

function vectorSumMagnitude(values: Float64Array | undefined): number {
  const sum = vectorSum(values);
  return Math.hypot(sum[0], sum[1], sum[2]);
}

function vectorSum(values: Float64Array | undefined): [number, number, number] {
  if (!values) return [0, 0, 0];
  let x = 0;
  let y = 0;
  let z = 0;
  for (let index = 0; index < values.length; index += 3) {
    x += values[index];
    y += values[index + 1];
    z += values[index + 2];
  }
  return [x, y, z];
}

function positiveMin(values: Float64Array): number | undefined {
  let min = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (value > 0 && Number.isFinite(value)) min = Math.min(min, value);
  }
  return Number.isFinite(min) ? min : undefined;
}
