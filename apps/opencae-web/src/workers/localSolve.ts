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
  return { summary: solved.summary, fields: solved.fields };
}
