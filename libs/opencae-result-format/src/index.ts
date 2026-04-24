import type { ResultField, ResultSummary } from "@opencae/schema";

export interface ResultArtifact {
  summary: ResultSummary;
  fields: ResultField[];
}
