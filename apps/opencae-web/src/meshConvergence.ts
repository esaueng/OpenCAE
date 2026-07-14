import type { DisplayModel, MeshConvergenceRecord, MeshConvergenceRung, ResultField, RunVariantResult, Study } from "@opencae/schema";
import { BROWSER_SOLVE_LIMITS } from "@opencae/solve-pipeline/limits";
import { barycentricVector } from "./resultSelection";
import type { SolverSurfaceMesh } from "./projectFile";

export const CONVERGENCE_PRESETS = ["coarse", "medium", "fine"] as const;
export const CONVERGENCE_DISPLACEMENT_THRESHOLD = 0.05;
export const CONVERGENCE_STRESS_THRESHOLD = 0.1;

type StaticStudy = Extract<Study, { type: "static_stress" }>;
type ConvergencePreset = (typeof CONVERGENCE_PRESETS)[number];
type RungStatistics = Pick<MeshConvergenceRung, "requestedPreset" | "actualNodeCount" | "actualElementCount" | "totalDofs" | "freeDofs" | "actualMeshSizeMm"> & {
  actualNodeCount: number;
  actualElementCount: number;
  totalDofs: number;
  freeDofs: number;
  actualMeshSizeMm: number;
};

export type ConvergenceMeshStatistics = {
  nodes: number;
  elements: number;
  totalDofs: number;
  freeDofs: number;
  actualMeshSizeMm: number;
};

export type PreparedConvergenceMesh = {
  study: StaticStudy;
  statistics: ConvergenceMeshStatistics;
};

export type ConvergenceSolveResult = {
  fields: ResultField[];
  variants?: RunVariantResult[];
  surfaceMesh?: unknown;
};

export type ConvergenceProbe = MeshConvergenceRecord["probe"];

export type MeshConvergenceRunInput = {
  study: StaticStudy;
  caseId: string;
  probe: ConvergenceProbe;
  prepareMesh: (preset: ConvergencePreset, isolatedStudy: StaticStudy) => Promise<PreparedConvergenceMesh>;
  solve: (study: StaticStudy, preset: ConvergencePreset) => Promise<ConvergenceSolveResult>;
  maxDofs?: number;
  recordId?: string;
  now?: () => string;
  onProgress?: (preset: ConvergencePreset, phase: "mesh" | "solve" | "complete" | "failed" | "skipped") => void;
};

export async function runStaticMeshConvergence(input: MeshConvergenceRunInput): Promise<MeshConvergenceRecord> {
  const now = input.now ?? (() => new Date().toISOString());
  const createdAt = now();
  const isolated = convergenceStudyForCase(input.study, input.caseId);
  const rungs: MeshConvergenceRung[] = [];
  const maxDofs = input.maxDofs ?? BROWSER_SOLVE_LIMITS.maxDofs;

  for (const preset of CONVERGENCE_PRESETS) {
    input.onProgress?.(preset, "mesh");
    let prepared: PreparedConvergenceMesh;
    try {
      prepared = await input.prepareMesh(preset, {
        ...isolated,
        meshSettings: { preset, status: "not_started" }
      });
    } catch (error) {
      rungs.push({ requestedPreset: preset, status: "failed", skipReason: errorMessage(error, "Mesh generation failed.") });
      input.onProgress?.(preset, "failed");
      continue;
    }

    const base = rungStatistics(preset, prepared.statistics);
    if (!base) {
      rungs.push({ requestedPreset: preset, status: "failed", skipReason: "Mesh generation did not report finite actual mesh statistics." });
      input.onProgress?.(preset, "failed");
      continue;
    }
    if (base.totalDofs > maxDofs) {
      rungs.push({
        ...base,
        status: "skipped",
        skipReason: `Generated mesh has ${base.totalDofs.toLocaleString()} DOF, above the ${maxDofs.toLocaleString()} browser pipeline limit.`
      });
      input.onProgress?.(preset, "skipped");
      continue;
    }

    input.onProgress?.(preset, "solve");
    try {
      const result = await input.solve(prepared.study, preset);
      const metrics = convergenceMetrics(result, input.caseId, input.probe.point);
      rungs.push({ ...base, status: "complete", ...metrics });
      input.onProgress?.(preset, "complete");
    } catch (error) {
      rungs.push({ ...base, status: "failed", skipReason: errorMessage(error, "Solve or probe mapping failed.") });
      input.onProgress?.(preset, "failed");
    }
  }

  const classification = classifyConvergenceRungs(rungs);
  return {
    id: input.recordId ?? convergenceRecordId(),
    studyId: input.study.id,
    caseId: input.caseId,
    createdAt,
    completedAt: now(),
    probe: input.probe,
    rungs,
    classification: classification.classification,
    ...(classification.lastStepChanges ? { lastStepChanges: classification.lastStepChanges } : {})
  };
}

export function convergenceStudyForCase(study: StaticStudy, caseId: string): StaticStudy {
  const loadCases = study.loadCases?.length
    ? study.loadCases
    : [{ id: "case-default", name: "Default", enabled: true, loadIds: study.loads.map((load) => load.id) }];
  const selected = loadCases.find((loadCase) => loadCase.id === caseId);
  if (!selected) throw new Error(`Static load case ${caseId} does not exist.`);
  const loadIds = new Set(selected.loadIds);
  const loads = study.loads.filter((load) => loadIds.has(load.id));
  if (!loads.length) throw new Error(`Static load case ${selected.name} has no loads to converge.`);
  return {
    ...study,
    loads,
    loadCases: [{ ...selected, enabled: true, loadIds: loads.map((load) => load.id) }],
    loadCombinations: [],
    meshSettings: { preset: "coarse", status: "not_started" },
    runs: []
  };
}

export function defaultConvergenceProbe(study: StaticStudy, caseId: string, displayModel: DisplayModel): ConvergenceProbe | null {
  const isolated = convergenceStudyForCase(study, caseId);
  const load = isolated.loads[0];
  if (!load) return null;
  const applicationPoint = finiteVec3(load.parameters.applicationPoint);
  if (applicationPoint) return { point: applicationPoint, source: "primary_load", label: "Primary load application point" };
  const selection = isolated.namedSelections.find((candidate) => candidate.id === load.selectionRef);
  const faceId = selection?.geometryRefs.find((reference) => reference.entityType === "face")?.entityId;
  const face = displayModel.faces.find((candidate) => candidate.id === faceId);
  return face ? { point: face.center, source: "primary_load", label: face.label } : null;
}

export function classifyConvergenceRungs(rungs: readonly MeshConvergenceRung[]): Pick<MeshConvergenceRecord, "classification" | "lastStepChanges"> {
  const complete = rungs.filter((rung): rung is MeshConvergenceRung & Required<Pick<MeshConvergenceRung, "totalDofs" | "probeDisplacement" | "rawElementPeakVonMises">> =>
    rung.status === "complete"
      && finiteNonnegative(rung.probeDisplacement)
      && finiteNonnegative(rung.rawElementPeakVonMises)
      && finitePositive(rung.totalDofs)
  );
  if (complete.length !== 3 || complete.some((rung, index) => index > 0 && rung.totalDofs <= complete[index - 1]!.totalDofs)) {
    return { classification: "inconclusive" };
  }
  const medium = complete[1]!;
  const fine = complete[2]!;
  const lastStepChanges = {
    displacement: symmetricRelativeChange(medium.probeDisplacement, fine.probeDisplacement),
    stress: symmetricRelativeChange(medium.rawElementPeakVonMises, fine.rawElementPeakVonMises)
  };
  return {
    classification: lastStepChanges.displacement <= CONVERGENCE_DISPLACEMENT_THRESHOLD + 1e-12
      && lastStepChanges.stress <= CONVERGENCE_STRESS_THRESHOLD + 1e-12
      ? "apparent_convergence"
      : "unconverged",
    lastStepChanges
  };
}

export type MappedSurfaceProbe = {
  surfaceMeshId: string;
  triangle: [number, number, number];
  barycentric: [number, number, number];
  distance: number;
  coordinateScale: number;
};

export function mapPointToNearestSurfaceTriangle(
  point: [number, number, number],
  surfaceMesh: SolverSurfaceMesh,
  coordinateScales: readonly number[] = [1, 0.001, 1000]
): MappedSurfaceProbe | null {
  if (!finiteVec3(point) || !surfaceMesh.nodes.length || !surfaceMesh.triangles.length) return null;
  const diagonal = surfaceDiagonal(surfaceMesh.nodes);
  if (!Number.isFinite(diagonal) || diagonal <= 0) return null;
  const tolerance = Math.max(diagonal * 1e-5, 1e-12);
  let best: (MappedSurfaceProbe & { distanceSquared: number }) | undefined;
  for (const coordinateScale of [...new Set(coordinateScales)]) {
    if (!Number.isFinite(coordinateScale) || coordinateScale <= 0) continue;
    const scaled: [number, number, number] = [point[0] * coordinateScale, point[1] * coordinateScale, point[2] * coordinateScale];
    for (const triangle of surfaceMesh.triangles) {
      const a = surfaceMesh.nodes[triangle[0]];
      const b = surfaceMesh.nodes[triangle[1]];
      const c = surfaceMesh.nodes[triangle[2]];
      if (!a || !b || !c) continue;
      const closest = closestPointOnTriangle(scaled, a, b, c);
      if (!closest || (best && closest.distanceSquared >= best.distanceSquared - 1e-30)) continue;
      best = {
        surfaceMeshId: surfaceMesh.id,
        triangle,
        barycentric: closest.barycentric,
        distance: Math.sqrt(closest.distanceSquared),
        distanceSquared: closest.distanceSquared,
        coordinateScale
      };
    }
  }
  if (!best || best.distance > tolerance) return null;
  const { distanceSquared: _distanceSquared, ...mapped } = best;
  return mapped;
}

function convergenceMetrics(result: ConvergenceSolveResult, caseId: string, probePoint: [number, number, number]) {
  const variant = result.variants?.find((candidate) => candidate.caseId === caseId || candidate.id === `case:${caseId}`);
  const fields = variant?.fields ?? result.fields;
  const surfaceMesh = solverSurfaceMesh(result.surfaceMesh);
  if (!surfaceMesh) throw new Error("Convergence solve returned no solver-surface mesh for the displacement probe.");
  const mapped = mapPointToNearestSurfaceTriangle(probePoint, surfaceMesh);
  if (!mapped) throw new Error("Displacement probe could not be mapped to the nearest solver-surface triangle within the scale-aware tolerance.");
  const displacement = fields.find((field) => field.type === "displacement"
    && field.location === "node"
    && field.surfaceMeshRef === surfaceMesh.id
    && field.vectors?.length === surfaceMesh.nodes.length);
  if (!displacement?.vectors) throw new Error("Convergence solve returned no aligned displacement-vector surface field.");
  const vector = barycentricVector(displacement.vectors, mapped.triangle, mapped.barycentric);
  if (!vector) throw new Error("Displacement probe interpolation failed on the mapped solver-surface triangle.");
  const stress = fields.find((field) => field.type === "stress"
    && field.location === "element"
    && (field.component === "von_mises" || field.id.includes("stress-von-mises-element")));
  if (!stress) throw new Error("Convergence solve returned no raw element von Mises field.");
  const rawElementPeakVonMises = maxFiniteAbsolute(stress.values);
  if (!Number.isFinite(rawElementPeakVonMises)) throw new Error("Raw element von Mises field contained no finite values.");
  return {
    rawElementPeakVonMises,
    stressUnits: stress.units,
    probeDisplacement: Math.hypot(vector[0], vector[1], vector[2]),
    displacementUnits: displacement.units
  };
}

function rungStatistics(preset: ConvergencePreset, statistics: ConvergenceMeshStatistics): RungStatistics | null {
  if (!finitePositive(statistics.nodes)
    || !finitePositive(statistics.elements)
    || !finitePositive(statistics.totalDofs)
    || !finiteNonnegative(statistics.freeDofs)
    || statistics.freeDofs > statistics.totalDofs
    || !finitePositive(statistics.actualMeshSizeMm)) return null;
  return {
    requestedPreset: preset,
    actualNodeCount: Math.round(statistics.nodes),
    actualElementCount: Math.round(statistics.elements),
    totalDofs: Math.round(statistics.totalDofs),
    freeDofs: Math.round(statistics.freeDofs),
    actualMeshSizeMm: statistics.actualMeshSizeMm
  };
}

function solverSurfaceMesh(value: unknown): SolverSurfaceMesh | null {
  if (!value || typeof value !== "object") return null;
  const mesh = value as Partial<SolverSurfaceMesh>;
  if (typeof mesh.id !== "string" || !Array.isArray(mesh.nodes) || !Array.isArray(mesh.triangles)) return null;
  return mesh as SolverSurfaceMesh;
}

function closestPointOnTriangle(
  point: [number, number, number],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number]
): { barycentric: [number, number, number]; distanceSquared: number } | null {
  const ab = subtract(b, a);
  const ac = subtract(c, a);
  const bc = subtract(c, b);
  const areaSquared = squaredNorm(cross(ab, ac));
  const edgeScaleSquared = Math.max(squaredNorm(ab), squaredNorm(ac), squaredNorm(bc));
  if (!Number.isFinite(areaSquared) || edgeScaleSquared <= 0 || areaSquared <= edgeScaleSquared * edgeScaleSquared * 1e-24) return null;
  const ap = subtract(point, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  let barycentric: [number, number, number];
  if (d1 <= 0 && d2 <= 0) barycentric = [1, 0, 0];
  else {
    const bp = subtract(point, b);
    const d3 = dot(ab, bp);
    const d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) barycentric = [0, 1, 0];
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        barycentric = [1 - v, v, 0];
      } else {
        const cp = subtract(point, c);
        const d5 = dot(ab, cp);
        const d6 = dot(ac, cp);
        if (d6 >= 0 && d5 <= d6) barycentric = [0, 0, 1];
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6);
            barycentric = [1 - w, 0, w];
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
              barycentric = [0, 1 - w, w];
            } else {
              const denominator = va + vb + vc;
              if (!Number.isFinite(denominator) || Math.abs(denominator) <= Number.EPSILON * edgeScaleSquared * edgeScaleSquared) return null;
              const inverse = 1 / denominator;
              const v = vb * inverse;
              const w = vc * inverse;
              barycentric = [1 - v - w, v, w];
            }
          }
        }
      }
    }
  }
  const closest: [number, number, number] = [
    a[0] * barycentric[0] + b[0] * barycentric[1] + c[0] * barycentric[2],
    a[1] * barycentric[0] + b[1] * barycentric[1] + c[1] * barycentric[2],
    a[2] * barycentric[0] + b[2] * barycentric[1] + c[2] * barycentric[2]
  ];
  return { barycentric, distanceSquared: squaredNorm(subtract(point, closest)) };
}

function surfaceDiagonal(nodes: ArrayLike<[number, number, number]>): number {
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (const node of Array.from(nodes)) {
    if (!finiteVec3(node)) continue;
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, node[axis]!);
      max[axis] = Math.max(max[axis]!, node[axis]!);
    }
  }
  return Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!);
}

function symmetricRelativeChange(previous: number, current: number): number {
  const scale = Math.max(Math.abs(previous), Math.abs(current));
  return scale <= Number.MIN_VALUE ? 0 : Math.abs(current - previous) / scale;
}

function maxFiniteAbsolute(values: ArrayLike<number>): number {
  let max = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value !== undefined && Number.isFinite(value)) max = Math.max(max, Math.abs(value));
  }
  return max;
}

function finiteVec3(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) return null;
  return [value[0] as number, value[1] as number, value[2] as number];
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function subtract(left: [number, number, number], right: [number, number, number]): [number, number, number] {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function dot(left: [number, number, number], right: [number, number, number]): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross(left: [number, number, number], right: [number, number, number]): [number, number, number] {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0]
  ];
}

function squaredNorm(value: [number, number, number]): number {
  return dot(value, value);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function convergenceRecordId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `convergence-${crypto.randomUUID()}`
    : `convergence-${Date.now().toString(36)}`;
}
