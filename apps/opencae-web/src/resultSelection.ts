import type { ResultField, RunVariantResult, StressComponent } from "@opencae/schema";
import type { SolverSurfaceMesh } from "./projectFile";
import type { ResultMode } from "./workspaceViewTypes";
import { deriveStressScalars } from "./stressTensor";

export const DEFAULT_STRESS_COMPONENT: StressComponent = "von_mises";
export const MAX_RESULT_PROBES = 20;

export type ResultProbeAnchor =
  | {
      kind: "surface";
      surfaceMeshId: string;
      triangle: [number, number, number];
      barycentric: [number, number, number];
    }
  | {
      kind: "sample";
      point: [number, number, number];
    };

export interface ResultProbePin {
  id: string;
  anchor: ResultProbeAnchor;
}

export interface ResolvedResultProbe {
  id: string;
  anchor: ResultProbeAnchor;
  point: [number, number, number];
  value: number;
  units: string;
  governingVariantName?: string;
}

export function resultProbeTopologySignature(
  projectId: string | undefined,
  runId: string | undefined,
  modelId: string | undefined,
  surfaceMesh?: Pick<SolverSurfaceMesh, "id" | "nodes" | "triangles">,
  variantId?: string
): string {
  return [
    projectId ?? "no-project",
    runId ?? "no-run",
    variantId ?? "no-variant",
    modelId ?? "no-model",
    surfaceMesh?.id ?? "no-surface",
    surfaceMesh?.nodes.length ?? 0,
    surfaceMesh?.triangles.length ?? 0
  ].join("|");
}

export function appendResultProbe(
  pins: ResultProbePin[],
  anchor: ResultProbeAnchor,
  id: string
): { pins: ResultProbePin[]; limitReached: boolean } {
  if (pins.length >= MAX_RESULT_PROBES) return { pins, limitReached: true };
  return { pins: [...pins, { id, anchor }], limitReached: false };
}

export interface ActiveResultFieldSelection {
  scalarField?: ResultField;
  displacementField?: ResultField;
}

export interface ActiveResultFieldOptions {
  fields: ResultField[];
  resultMode: ResultMode;
  stressComponent?: StressComponent;
  surfaceMesh?: SolverSurfaceMesh;
  frameIndex?: number;
  modeIndex?: number;
}

const derivedStressFieldCache = new WeakMap<ResultField, Map<StressComponent, ResultField>>();

export function availableStressComponents(fields: ResultField[]): StressComponent[] {
  const components: StressComponent[] = [];
  if (fields.some((field) => field.type === "stress")) components.push("von_mises");
  if (fields.some(hasStressTensors)) components.push("principal_max", "principal_min", "max_shear");
  for (const component of ["principal_max", "principal_min", "max_shear"] as const) {
    if (fields.some((field) => field.type === "stress" && field.component === component) && !components.includes(component)) components.push(component);
  }
  return components;
}

/**
 * Single scalar-field selection seam shared by contours, legends, probes, and
 * playback. Legacy stress fields without a component are explicitly treated as
 * von Mises so old autosaves and runner payloads remain readable.
 */
export function selectActiveResultField({
  fields,
  resultMode,
  stressComponent = DEFAULT_STRESS_COMPONENT,
  surfaceMesh,
  frameIndex,
  modeIndex
}: ActiveResultFieldOptions): ActiveResultFieldSelection {
  const frameFields = fieldsForRequestedMode(fieldsForRequestedFrame(fields, frameIndex), modeIndex);
  let candidates = frameFields.filter((field) =>
    field.type === resultMode && (resultMode !== "stress" || stressComponentForField(field) === stressComponent)
  );
  if (resultMode === "stress" && stressComponent !== "von_mises" && candidates.length === 0) {
    candidates = frameFields.filter(hasStressTensors).map((field) => derivedStressField(field, stressComponent));
  }
  const scalarField = surfaceMesh
    ? candidates.find((field) => isAlignedSurfaceNodeField(field, surfaceMesh))
      ?? candidates.find((field) => field.location === "face")
      ?? candidates.find((field) => Boolean(field.samples?.length))
      ?? candidates[0]
    : candidates.find((field) => field.location === "face")
      ?? candidates.find((field) => Boolean(field.samples?.length))
      ?? candidates[0];
  const displacementCandidates = frameFields.filter((field) => field.type === (resultMode === "mode_shape" ? "mode_shape" : "displacement"));
  const displacementField = surfaceMesh
    ? displacementCandidates.find((field) => isAlignedSurfaceNodeField(field, surfaceMesh)) ?? displacementCandidates[0]
    : displacementCandidates[0];
  return {
    ...(scalarField ? { scalarField } : {}),
    ...(displacementField ? { displacementField } : {})
  };
}

export function derivedStressFieldsForComponent(fields: ResultField[], component: StressComponent): ResultField[] {
  if (component === "von_mises") return fields.filter((field) => field.type === "stress" && stressComponentForField(field) === component);
  return fields.filter(hasStressTensors).map((field) => derivedStressField(field, component));
}

function hasStressTensors(field: ResultField): boolean {
  return field.type === "stress"
    && stressComponentForField(field) === "von_mises"
    && field.tensorValues?.length === field.values.length * 6;
}

function derivedStressField(source: ResultField, component: StressComponent): ResultField {
  let byComponent = derivedStressFieldCache.get(source);
  if (!byComponent) {
    byComponent = new Map();
    derivedStressFieldCache.set(source, byComponent);
  }
  const cached = byComponent.get(component);
  if (cached) return cached;
  const values = deriveStressScalars(source.tensorValues ?? [], component);
  const derived: ResultField = {
    ...source,
    id: `${source.id}-${component}`,
    component,
    values,
    min: Math.min(...values),
    max: Math.max(...values),
    ...(source.samples?.length === values.length
      ? { samples: source.samples.map((sample, index) => ({ ...sample, value: values[index] ?? sample.value })) }
      : { samples: undefined })
  };
  byComponent.set(component, derived);
  return derived;
}
export function stressComponentForField(field: Pick<ResultField, "type" | "component">): StressComponent | undefined {
  if (field.type !== "stress") return undefined;
  return field.component ?? DEFAULT_STRESS_COMPONENT;
}

export function semanticResultFieldKey(field: Pick<ResultField, "runId" | "variantId" | "type" | "location" | "component" | "modeIndex">): string {
  return `${field.runId}\u0000${field.variantId ?? "default"}\u0000${field.type}\u0000${field.location}\u0000${stressComponentForField(field) ?? "none"}\u0000${field.modeIndex ?? "none"}`;
}

export function isAlignedSurfaceNodeField(field: ResultField, surfaceMesh: SolverSurfaceMesh): boolean {
  return field.location === "node"
    && field.surfaceMeshRef === surfaceMesh.id
    && field.values.length === surfaceMesh.nodes.length;
}

export function resolveResultProbe(
  pin: ResultProbePin,
  scalarField: ResultField | undefined,
  surfaceMesh?: SolverSurfaceMesh
): ResolvedResultProbe | null {
  if (!scalarField) return null;
  if (pin.anchor.kind === "surface") {
    if (!surfaceMesh || pin.anchor.surfaceMeshId !== surfaceMesh.id) return null;
    if (!isAlignedSurfaceNodeField(scalarField, surfaceMesh)) return null;
    const point = barycentricPoint(surfaceMesh.nodes, pin.anchor.triangle, pin.anchor.barycentric);
    const value = barycentricScalar(scalarField.values, pin.anchor.triangle, pin.anchor.barycentric);
    if (!point || !Number.isFinite(value)) return null;
    return { id: pin.id, anchor: pin.anchor, point, value, units: scalarField.units };
  }
  const samples = scalarField.samples;
  if (!samples?.length) return null;
  const value = interpolateScalarFromSamples(pin.anchor.point, samples);
  if (!Number.isFinite(value)) return null;
  return { id: pin.id, anchor: pin.anchor, point: pin.anchor.point, value, units: scalarField.units };
}

/** Resolve the compact envelope index near a barycentric surface probe. */
export function governingVariantIdForProbe(
  pin: ResultProbePin,
  governing: RunVariantResult["governingVariantIndices"],
  mode: "stress" | "displacement"
): string | undefined {
  if (!governing || pin.anchor.kind !== "surface") return undefined;
  const nodeIndices = governing[mode];
  const votes = new Map<number, number>();
  for (let localNode = 0; localNode < 3; localNode += 1) {
    const node = pin.anchor.triangle[localNode];
    const weight = pin.anchor.barycentric[localNode];
    if (node === undefined || weight === undefined) continue;
    const governingIndex = nodeIndices[node];
    if (governingIndex === undefined || !Number.isInteger(governingIndex) || !Number.isFinite(weight) || weight < 0 || governingIndex < 0 || governingIndex >= governing.variantIds.length) continue;
    votes.set(governingIndex, (votes.get(governingIndex) ?? 0) + weight);
  }
  let bestIndex: number | undefined;
  let bestWeight = Number.NEGATIVE_INFINITY;
  for (const [index, weight] of votes) {
    if (weight <= bestWeight + 1e-12) continue;
    bestIndex = index;
    bestWeight = weight;
  }
  return bestIndex === undefined ? undefined : governing.variantIds[bestIndex];
}
export function barycentricScalar(
  values: ArrayLike<number>,
  triangle: [number, number, number],
  barycentric: [number, number, number]
): number {
  const [a, b, c] = triangle;
  const [wa, wb, wc] = barycentric;
  const va = values[a];
  const vb = values[b];
  const vc = values[c];
  if (![va, vb, vc, wa, wb, wc].every(Number.isFinite)) return Number.NaN;
  return (va ?? 0) * wa + (vb ?? 0) * wb + (vc ?? 0) * wc;
}

export function barycentricVector(
  values: ArrayLike<[number, number, number]>,
  triangle: [number, number, number],
  barycentric: [number, number, number]
): [number, number, number] | null {
  const a = values[triangle[0]];
  const b = values[triangle[1]];
  const c = values[triangle[2]];
  if (!a || !b || !c || ![...a, ...b, ...c, ...barycentric].every(Number.isFinite)) return null;
  return [
    a[0] * barycentric[0] + b[0] * barycentric[1] + c[0] * barycentric[2],
    a[1] * barycentric[0] + b[1] * barycentric[1] + c[1] * barycentric[2],
    a[2] * barycentric[0] + b[2] * barycentric[1] + c[2] * barycentric[2]
  ];
}
export function barycentricPoint(
  points: ArrayLike<[number, number, number]>,
  triangle: [number, number, number],
  barycentric: [number, number, number]
): [number, number, number] | null {
  const a = points[triangle[0]];
  const b = points[triangle[1]];
  const c = points[triangle[2]];
  if (!a || !b || !c || ![...a, ...b, ...c, ...barycentric].every(Number.isFinite)) return null;
  return [
    a[0] * barycentric[0] + b[0] * barycentric[1] + c[0] * barycentric[2],
    a[1] * barycentric[0] + b[1] * barycentric[1] + c[1] * barycentric[2],
    a[2] * barycentric[0] + b[2] * barycentric[1] + c[2] * barycentric[2]
  ];
}

/** Eight-neighbor inverse-distance interpolation used by procedural results. */
export function interpolateScalarFromSamples(
  point: [number, number, number],
  samples: NonNullable<ResultField["samples"]>
): number {
  const neighbors = samples
    .map((sample) => ({ sample, distanceSq: squaredDistance(point, sample.point) }))
    .filter((entry) => Number.isFinite(entry.sample.value) && Number.isFinite(entry.distanceSq))
    .sort((left, right) => left.distanceSq - right.distanceSq)
    .slice(0, Math.min(8, Math.max(3, samples.length)));
  if (!neighbors.length) return Number.NaN;
  const exact = neighbors.find((entry) => entry.distanceSq <= 1e-18);
  if (exact) return exact.sample.value;
  let weighted = 0;
  let totalWeight = 0;
  for (const neighbor of neighbors) {
    const weight = 1 / Math.max(neighbor.distanceSq, 1e-18);
    weighted += neighbor.sample.value * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? weighted / totalWeight : Number.NaN;
}

function fieldsForRequestedFrame(fields: ResultField[], frameIndex: number | undefined): ResultField[] {
  if (frameIndex === undefined || !fields.some((field) => field.frameIndex !== undefined)) return fields;
  const exact = fields.filter((field) => (field.frameIndex ?? 0) === frameIndex);
  return exact.length ? exact : fields;
}

function fieldsForRequestedMode(fields: ResultField[], modeIndex: number | undefined): ResultField[] {
  if (modeIndex === undefined || !fields.some((field) => field.modeIndex !== undefined)) return fields;
  const exact = fields.filter((field) => field.modeIndex === modeIndex);
  return exact.length ? exact : fields;
}
function squaredDistance(left: [number, number, number], right: [number, number, number]): number {
  const dx = left[0] - right[0];
  const dy = left[1] - right[1];
  const dz = left[2] - right[2];
  return dx * dx + dy * dy + dz * dz;
}
