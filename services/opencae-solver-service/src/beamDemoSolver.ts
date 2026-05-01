import { effectiveMaterialProperties, starterMaterials } from "@opencae/materials";
import { assessResultFailure } from "@opencae/schema";
import type { AnalysisMesh, Load, Material, ResultField, ResultSample, ResultSummary, Study } from "@opencae/schema";

type Vec3 = [number, number, number];

export type BeamDemoCoordinate = {
  fixedEnd: Vec3;
  beamFreeEnd: Vec3;
  beamAxis: Vec3;
  length: number;
  payloadStation: number;
  loadDirection: Vec3;
};

export type BeamDemoSolveResult = {
  summary: ResultSummary;
  fields: ResultField[];
  faceCount: number;
  loadCount: number;
  totalAppliedLoad: number;
  material: Material;
  effectiveMaterial: Material;
  materialParameters: Record<string, unknown>;
  analysisSampleCount: number;
  solverBackend: "local-beam-demo-euler-bernoulli";
  beamDemoDiagnostics: {
    beamAxis: Vec3;
    fixedEnd: Vec3;
    freeEnd: Vec3;
    loadStation: number;
    loadForceN: number;
    elementCount: number;
    maxDisplacementMm: number;
    maxStressMPa: number;
    yieldMPa: number;
  };
};

const STANDARD_GRAVITY = 9.80665;
const BEAM_ELEMENT_COUNT = 64;
const DISPLAY_BEAM_LENGTH = 3.8;
const BEAM_LENGTH_M = 0.16;
const BEAM_HEIGHT_M = 0.032;
const BEAM_WIDTH_M = 0.036;
const BEAM_DISPLAY_HEIGHT = 0.32;
const BEAM_DISPLAY_WIDTH = 0.72;
const REQUIRED_BEAM_FACE_IDS = ["face-base-left", "face-load-top", "face-web-front", "face-base-bottom"] as const;

const beamDemoFaces = new Map<string, { center: Vec3; normal: Vec3 }>([
  ["face-base-left", { center: [-1.9, 0.14, 0], normal: [-1, 0, 0] }],
  ["face-load-top", { center: [1.48, 0.49, 0], normal: [0, 1, 0] }],
  ["face-web-front", { center: [0, 0.38, 0], normal: [0, 1, 0] }],
  ["face-base-bottom", { center: [0, 0.14, 0], normal: [0, 0, 1] }]
]);

export function isBeamDemoStudy(study: Study): boolean {
  const entityIds = new Set(study.namedSelections.flatMap((selection) => selection.geometryRefs.map((ref) => ref.entityId)));
  if (!REQUIRED_BEAM_FACE_IDS.every((id) => entityIds.has(id))) return false;
  const selectionText = study.namedSelections
    .flatMap((selection) => [selection.name, ...selection.geometryRefs.map((ref) => ref.label)])
    .join(" ")
    .toLowerCase();
  const projectText = `${study.projectId} ${study.name}`.toLowerCase();
  return selectionText.includes("payload") || selectionText.includes("beam body") || projectText.includes("beam");
}

export function solveBeamDemoStudy(study: Study, runId: string, _analysisMeshInput?: AnalysisMesh): BeamDemoSolveResult {
  const material = materialForStudy(study);
  const materialParameters = materialParametersForStudy(study);
  const effectiveMaterial = effectiveMaterialProperties(material, materialParameters);
  const coordinate = beamDemoCoordinateForStudy(study);
  const load = primaryBeamLoad(study);
  const loadForceN = load ? equivalentLoadForce(load) : 0;
  const loadStation = coordinate.payloadStation;
  const elementCount = BEAM_ELEMENT_COUNT;
  const nodeCount = elementCount + 1;
  const le = BEAM_LENGTH_M / elementCount;
  const i = (BEAM_WIDTH_M * BEAM_HEIGHT_M ** 3) / 12;
  const c = BEAM_HEIGHT_M / 2;
  const displacements = solveBeamDeflection({
    elementCount,
    elementLength: le,
    youngsModulusPa: Math.max(effectiveMaterial.youngsModulus, 1),
    secondMomentM4: i,
    loadForceN,
    loadStation
  });
  const momentsNmm = Array.from({ length: nodeCount }, (_, index) => {
    const x = (index / elementCount) * BEAM_LENGTH_M;
    const a = loadStation * BEAM_LENGTH_M;
    return loadForceN * Math.max(a - x, 0) * 1000;
  });
  const stressMpa = momentsNmm.map((moment) => (moment * (c * 1000)) / (i * 1e12));
  const contactStressMpa = stressMpa.map((stress, index) => {
    const s = index / elementCount;
    const contact = stressMpa[0]! * 0.2 * Math.exp(-0.5 * ((s - loadStation) / 0.045) ** 2);
    return Math.max(stress, contact);
  });
  const displacementMm = displacements.map((value) => value * 1000);
  const maxDisplacementMm = Math.max(...displacementMm.map(Math.abs), 0);
  const maxStressMPa = Math.max(...contactStressMpa, 0);
  const yieldMPa = effectiveMaterial.yieldStrength / 1_000_000;
  const safetyValues = contactStressMpa.map((stress) => round(Math.max(0.05, yieldMPa / Math.max(stress, 0.001)), 4));
  const displacementSamples = beamSamples(coordinate, displacementMm, (value, _index) => ({
    value: round(Math.abs(value), 6),
    vector: roundVector(scale(coordinate.loadDirection, value), 6)
  }));
  const stressSamples = beamSamples(coordinate, contactStressMpa, (value) => ({
    value: round(value, 6),
    vonMisesStressPa: round(value * 1_000_000, 2)
  }));
  const safetySamples = beamSamples(coordinate, safetyValues, (value) => ({ value: round(value, 6) }));
  const fields: ResultField[] = [
    fieldFor(runId, "stress", contactStressMpa.map((value) => round(value, 6)), "MPa", stressSamples),
    fieldFor(runId, "displacement", displacementMm.map((value) => round(Math.abs(value), 6)), "mm", displacementSamples),
    fieldFor(runId, "safety_factor", safetyValues, "", safetySamples)
  ];
  const summaryBase = {
    maxStress: round(maxStressMPa, 6),
    maxStressUnits: "MPa",
    maxDisplacement: round(maxDisplacementMm, 6),
    maxDisplacementUnits: "mm",
    safetyFactor: round(Math.min(...safetyValues), 4),
    reactionForce: round(loadForceN, 6),
    reactionForceUnits: "N"
  };
  const summary: ResultSummary = {
    ...summaryBase,
    failureAssessment: assessResultFailure(summaryBase)
  };
  return {
    summary,
    fields,
    faceCount: REQUIRED_BEAM_FACE_IDS.length,
    loadCount: load ? 1 : 0,
    totalAppliedLoad: summary.reactionForce,
    material,
    effectiveMaterial,
    materialParameters,
    analysisSampleCount: displacementSamples.length,
    solverBackend: "local-beam-demo-euler-bernoulli",
    beamDemoDiagnostics: {
      beamAxis: coordinate.beamAxis,
      fixedEnd: coordinate.fixedEnd,
      freeEnd: coordinate.beamFreeEnd,
      loadStation,
      loadForceN: summary.reactionForce,
      elementCount,
      maxDisplacementMm: summary.maxDisplacement,
      maxStressMPa: summary.maxStress,
      yieldMPa: round(yieldMPa, 6)
    }
  };
}

function solveBeamDeflection(args: {
  elementCount: number;
  elementLength: number;
  youngsModulusPa: number;
  secondMomentM4: number;
  loadForceN: number;
  loadStation: number;
}) {
  const dofCount = (args.elementCount + 1) * 2;
  const k = Array.from({ length: dofCount }, () => Array.from({ length: dofCount }, () => 0));
  const f = Array.from({ length: dofCount }, () => 0);
  const le = args.elementLength;
  const factor = (args.youngsModulusPa * args.secondMomentM4) / le ** 3;
  const local = [
    [12, 6 * le, -12, 6 * le],
    [6 * le, 4 * le ** 2, -6 * le, 2 * le ** 2],
    [-12, -6 * le, 12, -6 * le],
    [6 * le, 2 * le ** 2, -6 * le, 4 * le ** 2]
  ].map((row) => row.map((value) => value * factor));

  for (let element = 0; element < args.elementCount; element += 1) {
    const dofs = [element * 2, element * 2 + 1, element * 2 + 2, element * 2 + 3];
    for (let row = 0; row < 4; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        const globalRow = dofs[row]!;
        const globalColumn = dofs[column]!;
        const stiffnessRow = k[globalRow]!;
        stiffnessRow[globalColumn] = (stiffnessRow[globalColumn] ?? 0) + (local[row]?.[column] ?? 0);
      }
    }
  }

  const loadPosition = clamp01(args.loadStation) * args.elementCount;
  const leftNode = Math.min(args.elementCount, Math.floor(loadPosition));
  const rightNode = Math.min(args.elementCount, leftNode + 1);
  const t = loadPosition - leftNode;
  const leftDof = leftNode * 2;
  const rightDof = rightNode * 2;
  f[leftDof] = (f[leftDof] ?? 0) + args.loadForceN * (1 - t);
  if (rightNode !== leftNode) f[rightDof] = (f[rightDof] ?? 0) + args.loadForceN * t;

  const freeDofs = Array.from({ length: dofCount - 2 }, (_, index) => index + 2);
  const reducedK = freeDofs.map((row) => freeDofs.map((column) => k[row]![column]!));
  const reducedF = freeDofs.map((dof) => f[dof]!);
  const solved = solveLinearSystem(reducedK, reducedF);
  const u = Array.from({ length: dofCount }, () => 0);
  for (let index = 0; index < freeDofs.length; index += 1) {
    u[freeDofs[index]!] = solved[index] ?? 0;
  }
  return Array.from({ length: args.elementCount + 1 }, (_, index) => u[index * 2]!);
}

function solveLinearSystem(matrix: number[][], rhs: number[]) {
  const n = rhs.length;
  const a = matrix.map((row, index) => [...row, rhs[index] ?? 0]);
  for (let pivot = 0; pivot < n; pivot += 1) {
    let maxRow = pivot;
    for (let row = pivot + 1; row < n; row += 1) {
      if (Math.abs(a[row]![pivot]!) > Math.abs(a[maxRow]![pivot]!)) maxRow = row;
    }
    [a[pivot], a[maxRow]] = [a[maxRow]!, a[pivot]!];
    const divisor = a[pivot]![pivot] || 1;
    for (let column = pivot; column <= n; column += 1) a[pivot]![column]! /= divisor;
    for (let row = 0; row < n; row += 1) {
      if (row === pivot) continue;
      const factor = a[row]![pivot]!;
      if (Math.abs(factor) < 1e-16) continue;
      for (let column = pivot; column <= n; column += 1) {
        a[row]![column]! -= factor * a[pivot]![column]!;
      }
    }
  }
  return a.map((row) => row[n] ?? 0);
}

function beamDemoCoordinateForStudy(study: Study): BeamDemoCoordinate {
  const fixedFace = faceForSelection(study, study.constraints.find((constraint) => constraint.type === "fixed")?.selectionRef)
    ?? beamDemoFaces.get("face-base-left")!;
  const load = primaryBeamLoad(study);
  const loadPoint = vectorFrom(load?.parameters.applicationPoint) ?? faceForSelection(study, load?.selectionRef)?.center ?? beamDemoFaces.get("face-load-top")!.center;
  const normal = normalized(fixedFace.normal);
  const axis = normalized(scale(normal, -1));
  const freeEnd = add(fixedFace.center, scale(axis, DISPLAY_BEAM_LENGTH));
  const payloadStation = clamp01(dot(sub(loadPoint, fixedFace.center), axis) / DISPLAY_BEAM_LENGTH);
  const loadDirection = normalized(vectorFrom(load?.parameters.direction) ?? [0, -1, 0]);
  return {
    fixedEnd: fixedFace.center,
    beamFreeEnd: freeEnd,
    beamAxis: axis,
    length: DISPLAY_BEAM_LENGTH,
    payloadStation,
    loadDirection
  };
}

function beamSamples(
  coordinate: BeamDemoCoordinate,
  nodeValues: number[],
  valueForNode: (value: number, index: number) => Pick<ResultSample, "value" | "vector" | "vonMisesStressPa">
): ResultSample[] {
  const side = normalized(cross(coordinate.beamAxis, coordinate.loadDirection));
  const transverse = normalized(cross(side, coordinate.beamAxis));
  const samples: ResultSample[] = [];
  for (let index = 0; index < nodeValues.length; index += 1) {
    const s = index / (nodeValues.length - 1);
    const center = add(coordinate.fixedEnd, scale(coordinate.beamAxis, coordinate.length * s));
    const offsets = [
      { source: "beam-demo-centerline", offset: [0, 0, 0] as Vec3 },
      { source: "beam-demo-top-fiber", offset: scale(transverse, BEAM_DISPLAY_HEIGHT / 2) },
      { source: "beam-demo-bottom-fiber", offset: scale(transverse, -BEAM_DISPLAY_HEIGHT / 2) },
      { source: "beam-demo-side-a", offset: scale(side, BEAM_DISPLAY_WIDTH / 2) },
      { source: "beam-demo-side-b", offset: scale(side, -BEAM_DISPLAY_WIDTH / 2) }
    ];
    for (const { source, offset } of offsets) {
      samples.push({
        point: roundVector(add(center, offset), 6),
        normal: [0, 1, 0],
        nodeId: `beam-node-${index}`,
        source,
        ...valueForNode(nodeValues[index] ?? 0, index)
      });
    }
  }
  return samples;
}

function fieldFor(runId: string, type: ResultField["type"], values: number[], units: string, samples: ResultSample[]): ResultField {
  const sampleValues = samples.map((sample) => sample.value);
  const allValues = values.length ? values : sampleValues;
  return {
    id: `${runId}-${type}`,
    runId,
    type,
    location: "node",
    values,
    min: round(Math.min(...allValues), 6),
    max: round(Math.max(...allValues, 0), 6),
    units,
    samples
  };
}

function primaryBeamLoad(study: Study): Load | undefined {
  return study.loads.find((load) => load.type === "gravity" || load.type === "force") ?? study.loads[0];
}

function equivalentLoadForce(load: Load): number {
  const value = typeof load.parameters.value === "number" ? Math.abs(load.parameters.value) : 0;
  if (load.type === "gravity" && load.parameters.units === "kg") return value * STANDARD_GRAVITY;
  return value;
}

function faceForSelection(study: Study, selectionRef: string | undefined) {
  const selection = study.namedSelections.find((candidate) => candidate.id === selectionRef);
  const ref = selection?.geometryRefs[0];
  const known = ref ? beamDemoFaces.get(ref.entityId) : undefined;
  if (known) return known;
  return ref ? { center: [0, 0, 0] as Vec3, normal: [1, 0, 0] as Vec3 } : undefined;
}

function materialForStudy(study: Study): Material {
  const materialId = study.materialAssignments[0]?.materialId;
  return starterMaterials.find((material) => material.id === materialId) ?? starterMaterials[0]!;
}

function materialParametersForStudy(study: Study): Record<string, unknown> {
  return study.materialAssignments[0]?.parameters ?? {};
}

function vectorFrom(value: unknown): Vec3 | undefined {
  return Array.isArray(value) && value.length === 3 && value.every((component) => typeof component === "number" && Number.isFinite(component))
    ? [value[0], value[1], value[2]]
    : undefined;
}

function normalized(vector: Vec3): Vec3 {
  const length = Math.hypot(...vector) || 1;
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function add(left: Vec3, right: Vec3): Vec3 {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function sub(left: Vec3, right: Vec3): Vec3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function scale(vector: Vec3, scalar: number): Vec3 {
  return [vector[0] * scalar, vector[1] * scalar, vector[2] * scalar];
}

function dot(left: Vec3, right: Vec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross(left: Vec3, right: Vec3): Vec3 {
  const crossed: Vec3 = [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0]
  ];
  return Math.hypot(...crossed) < 1e-9 ? [0, 0, 1] : crossed;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function roundVector(vector: Vec3, digits = 4): Vec3 {
  return [round(vector[0], digits), round(vector[1], digits), round(vector[2], digits)];
}
