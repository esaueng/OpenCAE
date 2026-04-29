import type { AnalysisMesh, MeshQuality, MeshSummary, Study } from "@opencae/schema";

export interface MeshService {
  generateMesh(study: Study, preset: MeshQuality, analysisMesh?: AnalysisMesh): Promise<{ artifactKey: string; summary: MeshSummary }>;
}
