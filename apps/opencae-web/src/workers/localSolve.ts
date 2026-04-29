import type { AnalysisMesh, Study } from "@opencae/schema";
import type { LocalSolveResult } from "./performanceProtocol";

export async function fallbackSolveLocalStudy({
  study,
  runId,
  analysisMesh
}: {
  study: Study;
  runId: string;
  analysisMesh?: AnalysisMesh;
}): Promise<LocalSolveResult> {
  const solver = await import("@opencae/solver-service");
  const solved = study.type === "dynamic_structural"
    ? solver.solveDynamicStudy(study, runId, analysisMesh)
    : solver.solveStudy(study, runId, analysisMesh);
  return { summary: solved.summary, fields: solved.fields };
}
