import type { AnalysisMesh, ResultField, ResultSummary, RunEvent, Study } from "@opencae/schema";

export interface ComputeBackend {
  runStaticSolve(args: {
    study: Study;
    runId: string;
    meshRef: string;
    analysisMesh?: AnalysisMesh;
    publish: (event: RunEvent) => void;
  }): Promise<{ resultRef: string; reportRef: string; summary: ResultSummary; fields: ResultField[] }>;
  runDynamicSolve(args: {
    study: Study;
    runId: string;
    meshRef: string;
    analysisMesh?: AnalysisMesh;
    publish: (event: RunEvent) => void;
  }): Promise<{ resultRef: string; reportRef: string; summary: ResultSummary; fields: ResultField[] }>;
}

export interface ReportProvider {
  generateReport(args: { projectId: string; runId: string; summary: ResultSummary; study?: Study; fields?: ResultField[] }): Promise<string>;
}
