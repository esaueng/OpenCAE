import { effectiveMaterialProperties, starterMaterials } from "@opencae/materials";
import { assessResultFailure } from "@opencae/schema";
import type { AnalysisMesh, DisplayModel, Load, Material, ResultField, ResultSample, ResultSummary, Study } from "@opencae/schema";
import { inferCriticalPrintAxis } from "@opencae/study-core";

type Vec3 = [number, number, number];

export type BeamDemoCoordinate = {
  fixedEnd: Vec3;
  beamFreeEnd: Vec3;
  beamAxis: Vec3;
  length: number;
  payloadStation: number;
  loadDirection: Vec3;
};

export type BeamDemoPhysicalModel = {
  beamLengthMm: number;
  beamWidthMm: number;
  beamHeightMm: number;
  payloadMassKg: number;
  fixedFaceId: "face-base-left";
  payloadFaceId: "face-load-top";
  beamAxisViewer: Vec3;
  loadDirectionViewer: Vec3;
};

export type BeamDemoSolveOptions = {
  analysisMesh?: AnalysisMesh;
  displayModel?: DisplayModel;
  beamModel?: BeamDemoPhysicalModel;
  debugResults?: boolean;
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
    payloadMassKg: number;
    beamLengthMm: number;
    beamWidthMm: number;
    beamHeightMm: number;
    youngsModulusPa: number;
    secondMomentM4: number;
    sectionCInM: number;
    expectedSigmaMaxMPa: number;
    expectedDeltaMaxMm: number;
  };
};

const STANDARD_GRAVITY = 9.80665;
const BEAM_ELEMENT_COUNT = 64;
const DISPLAY_BEAM_LENGTH = 3.8;
const BEAM_DISPLAY_HEIGHT = 0.32;
const BEAM_DISPLAY_WIDTH = 0.72;
const REQUIRED_BEAM_FACE_IDS = ["face-base-left", "face-load-top", "face-web-front", "face-base-bottom"] as const;

export const DEFAULT_BEAM_DEMO_PHYSICAL_MODEL: BeamDemoPhysicalModel = {
  beamLengthMm: 160,
  beamWidthMm: 15.1578947368,
  beamHeightMm: 11.7894736842,
  payloadMassKg: 0.497664,
  fixedFaceId: "face-base-left",
  payloadFaceId: "face-load-top",
  beamAxisViewer: [1, 0, 0],
  loadDirectionViewer: [0, -1, 0]
};

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
  return selectionText.includes("payload")
    || selectionText.includes("beam body")
    || selectionText.includes("free end load")
    || projectText.includes("beam")
    || projectText.includes("cantilever");
}

export function solveBeamDemoStudy(study: Study, runId: string, optionsInput?: AnalysisMesh | BeamDemoSolveOptions): BeamDemoSolveResult {
  const options = normalizeBeamDemoSolveOptions(optionsInput);
  const beamModel = options.beamModel ?? DEFAULT_BEAM_DEMO_PHYSICAL_MODEL;
  const material = materialForStudy(study);
  const materialParameters = materialParametersForStudy(study);
  const effectiveMaterial = effectiveMaterialProperties(material, materialParameters, { criticalLayerAxis: beamCriticalPrintAxis(study) });
  const load = primaryBeamLoad(study);
  if (!load) throw new Error("Beam Demo solver requires a force or gravity payload load.");
  const coordinate = beamDemoCoordinateForStudy(study, beamModel, load);
  const loadForceN = equivalentLoadForce(load, beamModel);
  const loadStation = coordinate.payloadStation;
  const elementCount = beamElementCountForStudy(study);
  const nodeCount = elementCount + 1;
  const lengthM = beamModel.beamLengthMm / 1000;
  const heightM = beamModel.beamHeightMm / 1000;
  const youngsModulusPa = Math.max(effectiveMaterial.youngsModulus, 1);
  const i = secondMomentOfAreaM4(beamModel);
  const c = heightM / 2;
  const normalizedLoadStation = isEndLoadStation(loadStation) ? 1 : clamp01(loadStation);
  const a = normalizedLoadStation * lengthM;
  const tipDisplacementM = cantileverDisplacementM(loadForceN, lengthM, a, youngsModulusPa, i);
  const tipDisplacementMm = tipDisplacementM * 1000;
  const displacements = Array.from({ length: nodeCount }, (_, index) => {
    const s = index / elementCount;
    return (tipDisplacementMm * cantileverShapeForStation(s, normalizedLoadStation)) / 1000;
  });
  const stressMpa = Array.from({ length: nodeCount }, (_, index) => {
    const x = (index / elementCount) * lengthM;
    const momentNm = loadForceN * Math.max(a - x, 0);
    return Math.abs((momentNm * c) / i) / 1_000_000;
  });
  const displacementMm = displacements.map((value) => value * 1000);
  const maxDisplacementMm = Math.max(...displacementMm.map(Math.abs), 0);
  const maxStressMPa = Math.max(...stressMpa, 0);
  const yieldMPa = effectiveMaterial.yieldStrength / 1_000_000;
  const safetyValues = stressMpa.map((stress) => round(Math.max(0.05, yieldMPa / Math.max(stress, 0.001)), 4));
  const displacementSamples = beamSamples(coordinate, displacementMm, (value, _index) => ({
    value: round(Math.abs(value), 6),
    vector: roundVector(scale(coordinate.loadDirection, value), 6)
  }));
  const stressSamples = beamSamples(coordinate, stressMpa, (value, _index, source) => {
    const sampleStress = value * stressFiberFactor(source);
    return {
      value: round(sampleStress, 6),
      vonMisesStressPa: round(sampleStress * 1_000_000, 2)
    };
  });
  const safetySamples = beamSamples(coordinate, safetyValues, (value) => ({ value: round(value, 6) }));
  const fields: ResultField[] = [
    fieldFor(runId, "stress", stressMpa.map((value) => round(value, 6)), "MPa", stressSamples),
    fieldFor(runId, "displacement", displacementMm.map((value) => round(Math.abs(value), 6)), "mm", displacementSamples),
    fieldFor(runId, "safety_factor", safetyValues, "", safetySamples)
  ];
  const expected = expectedBeamDemoExtrema(beamModel, effectiveMaterial, loadForceN);
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
  const diagnostics = {
    beamAxis: coordinate.beamAxis,
    fixedEnd: coordinate.fixedEnd,
    freeEnd: coordinate.beamFreeEnd,
    loadStation: normalizedLoadStation,
    loadForceN: summary.reactionForce,
    elementCount,
    maxDisplacementMm: summary.maxDisplacement,
    maxStressMPa: summary.maxStress,
    yieldMPa: round(yieldMPa, 6),
    payloadMassKg: load.type === "gravity" ? loadForceN / STANDARD_GRAVITY : beamModel.payloadMassKg,
    beamLengthMm: beamModel.beamLengthMm,
    beamWidthMm: beamModel.beamWidthMm,
    beamHeightMm: beamModel.beamHeightMm,
    youngsModulusPa,
    secondMomentM4: i,
    sectionCInM: c,
    expectedSigmaMaxMPa: expected.expectedSigmaMaxMPa,
    expectedDeltaMaxMm: expected.expectedDeltaMaxMm
  };
  if (options.debugResults) {
    auditBeamDemoInputs(study, options.displayModel, beamModel, { summary, material: effectiveMaterial, loadForceN });
    auditCantileverDebugResults(coordinate, normalizedLoadStation, tipDisplacementMm);
  }
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
    beamDemoDiagnostics: diagnostics
  };
}

function cantileverDisplacementM(loadForceN: number, x: number, loadStationM: number, youngsModulusPa: number, secondMomentM4: number) {
  const denominator = 6 * youngsModulusPa * secondMomentM4;
  if (denominator <= 0) return 0;
  if (x <= loadStationM) return loadForceN * x ** 2 * (3 * loadStationM - x) / denominator;
  return loadForceN * loadStationM ** 2 * (3 * x - loadStationM) / denominator;
}

export function endLoadCantileverShape(s: number): number {
  const t = clamp01(s);
  return 0.5 * t * t * (3 - t);
}

export function endLoadCantileverSlope(s: number, tipDisplacement: number, length: number): number {
  const t = clamp01(s);
  const safeLength = Math.max(Math.abs(length), 1e-9);
  return (tipDisplacement / safeLength) * (3 * t - 1.5 * t * t);
}

export function pointLoadCantileverShape(s: number, a: number): number {
  const x = clamp01(s);
  const aa = Math.max(1e-6, Math.min(1, a));

  if (x <= aa) {
    return x * x * (3 * aa - x);
  }

  return aa * aa * (3 * x - aa);
}

export function normalizedPointLoadCantileverShape(s: number, a: number): number {
  const aa = Math.max(1e-6, Math.min(1, a));
  const maxRaw = aa * aa * (3 - aa);
  return pointLoadCantileverShape(s, aa) / Math.max(maxRaw, 1e-9);
}

function cantileverShapeForStation(s: number, loadStation: number): number {
  return isEndLoadStation(loadStation)
    ? endLoadCantileverShape(s)
    : normalizedPointLoadCantileverShape(s, loadStation);
}

function isEndLoadStation(station: number): boolean {
  return station >= 0.95;
}

function beamElementCountForStudy(study: Study): number {
  if (study.meshSettings.preset === "ultra") return 128;
  if (study.meshSettings.preset === "fine") return 96;
  return BEAM_ELEMENT_COUNT;
}

function beamCriticalPrintAxis(study: Study) {
  const faces = [...beamDemoFaces.entries()].map(([entityId, face]) => ({
    selectionId: study.namedSelections.find((selection) => selection.geometryRefs.some((ref) => ref.entityId === entityId))?.id ?? entityId,
    entityId,
    center: face.center,
    normal: face.normal
  }));
  return inferCriticalPrintAxis(study, faces);
}

function beamDemoCoordinateForStudy(study: Study, beamModel: BeamDemoPhysicalModel, load: Load): BeamDemoCoordinate {
  const fixedSelectionRef = study.constraints.find((constraint) => constraint.type === "fixed")?.selectionRef;
  if (!fixedSelectionRef) throw new Error("Beam Demo solver requires a fixed support on face-base-left.");
  const fixedFace = faceForSelection(study, fixedSelectionRef);
  if (!fixedFace) throw new Error("Beam Demo solver requires the fixed support face-base-left.");
  const selectedLoadFace = faceForSelection(study, load?.selectionRef);
  const loadPoint = freeEndLoadSelection(study, load)
    ? freeEndPointForBeamModel(study, beamModel)
    : vectorFrom(load?.parameters.applicationPoint) ?? selectedLoadFace?.center ?? beamDemoFaces.get("face-load-top")!.center;
  const axis = normalized(beamModel.beamAxisViewer);
  const freeEnd = add(fixedFace.center, scale(axis, DISPLAY_BEAM_LENGTH));
  const payloadStation = load.type === "gravity"
    ? 1
    : clamp01(dot(sub(loadPoint, fixedFace.center), axis) / DISPLAY_BEAM_LENGTH);
  const loadDirection = normalized(vectorFrom(load?.parameters.direction) ?? beamModel.loadDirectionViewer);
  return {
    fixedEnd: fixedFace.center,
    beamFreeEnd: freeEnd,
    beamAxis: axis,
    length: DISPLAY_BEAM_LENGTH,
    payloadStation,
    loadDirection
  };
}

function freeEndLoadSelection(study: Study, load: Load): boolean {
  const selection = study.namedSelections.find((candidate) => candidate.id === load.selectionRef);
  const selectionText = [
    selection?.name,
    ...(selection?.geometryRefs.map((ref) => ref.label) ?? [])
  ].join(" ").toLowerCase();
  return load.type === "force" && selectionText.includes("free end");
}

function freeEndPointForBeamModel(study: Study, beamModel: BeamDemoPhysicalModel): Vec3 {
  const fixedSelectionRef = study.constraints.find((constraint) => constraint.type === "fixed")?.selectionRef;
  const fixedFace = faceForSelection(study, fixedSelectionRef) ?? beamDemoFaces.get("face-base-left")!;
  return add(fixedFace.center, scale(normalized(beamModel.beamAxisViewer), DISPLAY_BEAM_LENGTH));
}

function auditCantileverDebugResults(coordinate: BeamDemoCoordinate, loadStation: number, tipDisplacement: number) {
  const stations = [0, 0.25, 0.5, 0.75, 1];
  const audit = {
    beamAxis: coordinate.beamAxis,
    fixedEnd: coordinate.fixedEnd,
    loadEnd: coordinate.beamFreeEnd,
    loadDirection: coordinate.loadDirection,
    tipDisplacement: round(Math.abs(tipDisplacement), 6),
    stationSamples: stations.map((s) => {
      const displacementMagnitude = Math.abs(tipDisplacement * cantileverShapeForStation(s, loadStation));
      return {
        s: round(s, 4),
        displacementMagnitude: round(displacementMagnitude, 6),
        normalizedDisplacement: round(displacementMagnitude / Math.max(Math.abs(tipDisplacement), 1e-12), 4)
      };
    })
  };
  console.info("[OpenCAE debugResults] cantilever deformation audit", audit);
  return audit;
}

export function auditBeamDemoInputs(
  study: Study,
  displayModel: DisplayModel | undefined,
  beamModel: BeamDemoPhysicalModel,
  result?: { summary: ResultSummary; material: Material; loadForceN: number }
) {
  const material = result?.material ?? effectiveMaterialProperties(materialForStudy(study), materialParametersForStudy(study));
  const load = primaryBeamLoad(study);
  const loadForceN = result?.loadForceN ?? (load ? equivalentLoadForce(load, beamModel) : beamModel.payloadMassKg * STANDARD_GRAVITY);
  const expected = expectedBeamDemoExtrema(beamModel, material, loadForceN);
  const audit = {
    payloadMassKg: load?.type === "gravity" ? loadForceN / STANDARD_GRAVITY : beamModel.payloadMassKg,
    forceN: loadForceN,
    beamLengthMm: beamModel.beamLengthMm,
    beamWidthMm: beamModel.beamWidthMm,
    beamHeightMm: beamModel.beamHeightMm,
    displayDimensions: displayModel?.dimensions,
    EPa: material.youngsModulus,
    IPerm4: secondMomentOfAreaM4(beamModel),
    sectionCInM: beamModel.beamHeightMm / 2000,
    expectedSigmaMaxMPa: expected.expectedSigmaMaxMPa,
    expectedDeltaMaxMm: expected.expectedDeltaMaxMm,
    returnedMaxStress: result?.summary.maxStress,
    returnedMaxDisplacement: result?.summary.maxDisplacement,
    returnedSafetyFactor: result?.summary.safetyFactor
  };
  console.debug("[OpenCAE results] Beam Demo units audit", audit);
  if (result?.summary.maxStress && Math.abs(result.summary.maxStress - expected.expectedSigmaMaxMPa) / Math.max(expected.expectedSigmaMaxMPa, 1e-12) > 0.1) {
    console.warn("[OpenCAE results] Beam Demo max stress differs from analytical audit by more than 10%", audit);
  }
  return audit;
}

function expectedBeamDemoExtrema(beamModel: BeamDemoPhysicalModel, material: Material, loadForceN: number) {
  const lengthM = beamModel.beamLengthMm / 1000;
  const c = beamModel.beamHeightMm / 2000;
  const i = secondMomentOfAreaM4(beamModel);
  return {
    expectedSigmaMaxMPa: loadForceN * lengthM * c / i / 1_000_000,
    expectedDeltaMaxMm: loadForceN * lengthM ** 3 / (3 * material.youngsModulus * i) * 1000
  };
}

function secondMomentOfAreaM4(beamModel: BeamDemoPhysicalModel) {
  const widthM = beamModel.beamWidthMm / 1000;
  const heightM = beamModel.beamHeightMm / 1000;
  return widthM * heightM ** 3 / 12;
}

function normalizeBeamDemoSolveOptions(optionsInput: AnalysisMesh | BeamDemoSolveOptions | undefined): BeamDemoSolveOptions {
  if (!optionsInput) return {};
  if ("samples" in optionsInput) return { analysisMesh: optionsInput };
  return optionsInput;
}

function beamSamples(
  coordinate: BeamDemoCoordinate,
  nodeValues: number[],
  valueForNode: (value: number, index: number, source: string) => Pick<ResultSample, "value" | "vector" | "vonMisesStressPa">
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
        ...valueForNode(nodeValues[index] ?? 0, index, source)
      });
    }
  }
  return samples;
}

function stressFiberFactor(source: string): number {
  return source === "beam-demo-centerline" ? 0.4 : 1;
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

function equivalentLoadForce(load: Load, beamModel = DEFAULT_BEAM_DEMO_PHYSICAL_MODEL): number {
  const value = typeof load.parameters.value === "number" ? Math.abs(load.parameters.value) : 0;
  if (load.type === "gravity" && load.parameters.units === "kg") return (value || beamModel.payloadMassKg) * STANDARD_GRAVITY;
  return value;
}

function faceForSelection(study: Study, selectionRef: string | undefined) {
  const selection = study.namedSelections.find((candidate) => candidate.id === selectionRef);
  const ref = selection?.geometryRefs[0];
  return ref ? beamDemoFaces.get(ref.entityId) : undefined;
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
