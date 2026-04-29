import type { AnalysisMesh, MeshSummary, Study } from "@opencae/schema";

export interface MeshService {
  generateMesh(study: Study, preset: "coarse" | "medium" | "fine", analysisMesh?: AnalysisMesh): Promise<{ artifactKey: string; summary: MeshSummary }>;
}
