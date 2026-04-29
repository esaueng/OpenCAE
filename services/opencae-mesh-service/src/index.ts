import type { AnalysisMesh, MeshSummary, Study } from "@opencae/schema";
import type { ObjectStorageProvider } from "@opencae/storage";

export class MockMeshService {
  constructor(private readonly storage: ObjectStorageProvider) {}

  async generateMesh(study: Study, preset: "coarse" | "medium" | "fine", analysisMesh?: AnalysisMesh): Promise<{ artifactKey: string; summary: MeshSummary }> {
    const summaryByPreset: Record<typeof preset, MeshSummary> = {
      coarse: { nodes: 12840, elements: 7320, warnings: [], analysisSampleCount: analysisMesh?.samples.length ?? 1200, quality: "coarse" },
      medium: { nodes: 42381, elements: 26944, warnings: ["Small feature curvature represented by surface analysis samples."], analysisSampleCount: analysisMesh?.samples.length ?? 4800, quality: "medium" },
      fine: { nodes: 88420, elements: 57102, warnings: ["Fine surface analysis sampling enabled for higher-quality local results."], analysisSampleCount: analysisMesh?.samples.length ?? 19200, quality: "fine" }
    };
    const summary = summaryByPreset[preset];
    const artifactKey = `${study.projectId}/mesh/mesh-summary.json`;
    await this.storage.putObject(artifactKey, JSON.stringify(summary, null, 2));
    return { artifactKey, summary };
  }
}
