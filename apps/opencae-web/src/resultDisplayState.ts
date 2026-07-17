import { isModalResultSummary, isStructuralResultSummary, isThermalResultSummary } from "@opencae/schema";
import type { ResultField, ResultSummary, StressComponent, Study } from "@opencae/schema";
import type { SolverSurfaceMesh } from "./projectFile";
import { selectActiveResultField } from "./resultSelection";
import type { ResultMode } from "./workspaceViewTypes";

export interface ResultDisplayEligibilityInput {
  studyType: Study["type"];
  summary: ResultSummary | null;
  fields: ResultField[];
  completedRunId: string;
  resultMode: ResultMode;
  stressComponent?: StressComponent;
  surfaceMesh?: SolverSurfaceMesh;
  frameIndex?: number;
  modeIndex?: number;
}

export function resultSummaryMatchesStudy(summary: ResultSummary, studyType: Study["type"]): boolean {
  if (isThermalResultSummary(summary)) return studyType === "steady_state_thermal";
  if (isModalResultSummary(summary)) return studyType === "modal_analysis";
  if (!isStructuralResultSummary(summary)) return false;
  return summary.transient ? studyType === "dynamic_structural" : studyType === "static_stress";
}

export function isResultDisplayEligible({
  studyType,
  summary,
  fields,
  completedRunId,
  resultMode,
  stressComponent,
  surfaceMesh,
  frameIndex,
  modeIndex
}: ResultDisplayEligibilityInput): boolean {
  if (!summary || !completedRunId || !resultSummaryMatchesStudy(summary, studyType)) return false;
  const currentRunFields = fields.filter((field) => field.runId === completedRunId);
  if (!currentRunFields.length) return false;
  return Boolean(selectActiveResultField({
    fields: currentRunFields,
    resultMode,
    stressComponent,
    surfaceMesh,
    frameIndex,
    modeIndex
  }).scalarField);
}
