import type { AnalysisMesh, DisplayModel, Study } from "@opencae/schema";
import type { LocalSolveResult } from "./performanceProtocol";

export async function fallbackSolveLocalStudy({
  study,
  runId,
  analysisMesh,
  displayModel,
  debugResults
}: {
  study: Study;
  runId: string;
  analysisMesh?: AnalysisMesh;
  displayModel?: DisplayModel;
  debugResults?: boolean;
}): Promise<LocalSolveResult> {
  const solver = await import("@opencae/solver-service");
  const options = { analysisMesh, displayModel, debugResults };
  const solved = study.type === "dynamic_structural"
    ? solver.solveDynamicStudy(study, runId, options)
    : solver.solveStudy(study, runId, options);
  if (debugResults) logLocalSolveDirectionAudit(study, solved.fields);
  return { summary: solved.summary, fields: solved.fields };
}

function logLocalSolveDirectionAudit(study: Study, fields: LocalSolveResult["fields"]) {
  console.info("[OpenCAE debugResults] local solver direction audit", {
    studyId: study.id,
    studyType: study.type,
    loads: study.loads.map((load) => {
      const loadSelection = study.namedSelections.find((selection) => selection.id === load.selectionRef);
      const support = study.constraints
        .map((constraint) => study.namedSelections.find((selection) => selection.id === constraint.selectionRef))
        .find(Boolean);
      return {
        id: load.id,
        type: load.type,
        rawDirection: load.parameters.direction ?? null,
        parsedDirection: parseVector(load.parameters.direction),
        normalizedDirection: normalizeVector(parseVector(load.parameters.direction)),
        applicationPoint: load.parameters.applicationPoint ?? null,
        selectedLoadFace: loadSelection?.geometryRefs[0] ?? null,
        selectedSupportFace: support?.geometryRefs[0] ?? null
      };
    }),
    fields: fields
      .filter((field) => field.type === "displacement" || field.type === "velocity" || field.type === "acceleration")
      .map((field) => ({
        id: field.id,
        type: field.type,
        frameIndex: field.frameIndex,
        firstSampleVectors: field.samples?.slice(0, 5).map((sample) => sample.vector ?? null) ?? [],
        maxVector: maxVector(field.samples?.map((sample) => sample.vector).filter((vector): vector is [number, number, number] => Boolean(vector)) ?? []),
        dominantAxis: dominantAxis(field.samples?.map((sample) => sample.vector).filter((vector): vector is [number, number, number] => Boolean(vector)) ?? [])
      }))
  });
}

function parseVector(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const vector: [number, number, number] = [Number(value[0]), Number(value[1]), Number(value[2])];
  return vector.every(Number.isFinite) ? vector : null;
}

function normalizeVector(vector: [number, number, number] | null): [number, number, number] | null {
  if (!vector) return null;
  const magnitude = Math.hypot(...vector);
  return magnitude > 1e-12 ? [vector[0] / magnitude, vector[1] / magnitude, vector[2] / magnitude] : null;
}

function maxVector(vectors: Array<[number, number, number]>): [number, number, number] | null {
  return vectors.reduce<[number, number, number] | null>((max, vector) => (
    !max || Math.hypot(...vector) > Math.hypot(...max) ? vector : max
  ), null);
}

function dominantAxis(vectors: Array<[number, number, number]>): { axis: "x" | "y" | "z"; sign: -1 | 0 | 1 } {
  const absolute: [number, number, number] = [0, 0, 0];
  const signed: [number, number, number] = [0, 0, 0];
  for (const vector of vectors) {
    absolute[0] += Math.abs(vector[0]);
    absolute[1] += Math.abs(vector[1]);
    absolute[2] += Math.abs(vector[2]);
    signed[0] += vector[0];
    signed[1] += vector[1];
    signed[2] += vector[2];
  }
  const axisIndex = absolute[0] >= absolute[1] && absolute[0] >= absolute[2] ? 0 : absolute[1] >= absolute[2] ? 1 : 2;
  return {
    axis: (["x", "y", "z"] as const)[axisIndex],
    sign: signed[axisIndex] > 1e-9 ? 1 : signed[axisIndex] < -1e-9 ? -1 : 0
  };
}
