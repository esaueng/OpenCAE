import type { MeshSummary, Study } from "@opencae/schema";

export interface MeshService {
  generateMesh(study: Study, preset: "coarse" | "medium" | "fine"): Promise<{ artifactKey: string; summary: MeshSummary }>;
}
