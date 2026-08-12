import type { AnalysisMesh, MeshQuality, MeshSummary, Study } from "@opencae/schema";
import type { ObjectStorageProvider } from "@opencae/storage";

const PRESET_ESTIMATE_WARNING = "Node and element counts are preset planning estimates, not a generated finite-element mesh. Surface analysis samples are heuristic.";

export class MockMeshService {
  constructor(private readonly storage: ObjectStorageProvider) {}

  async generateMesh(study: Study, preset: MeshQuality, analysisMesh?: AnalysisMesh): Promise<{ artifactKey: string; summary: MeshSummary }> {
    const summaryByPreset: Record<MeshQuality, MeshSummary> = {
      coarse: { nodes: 12840, elements: 7320, warnings: [PRESET_ESTIMATE_WARNING], analysisSampleCount: analysisMesh?.samples.length ?? 1200, quality: "coarse", source: "preset_estimate" },
      medium: { nodes: 42381, elements: 26944, warnings: [PRESET_ESTIMATE_WARNING, "Medium heuristic surface-sample density selected."], analysisSampleCount: analysisMesh?.samples.length ?? 4800, quality: "medium", source: "preset_estimate" },
      fine: { nodes: 88420, elements: 57102, warnings: [PRESET_ESTIMATE_WARNING, "Fine heuristic surface-sample density selected."], analysisSampleCount: analysisMesh?.samples.length ?? 19200, quality: "fine", source: "preset_estimate" },
      ultra: { nodes: 182400, elements: 119808, warnings: [PRESET_ESTIMATE_WARNING, "Ultra heuristic surface-sample density selected."], analysisSampleCount: analysisMesh?.samples.length ?? 45000, quality: "ultra", source: "preset_estimate" }
    };
    const summary = summaryByPreset[preset];
    const artifactKey = `${study.projectId}/mesh/${study.id}/mesh-summary.json`;
    await this.storage.putObject(artifactKey, JSON.stringify(summary, null, 2));
    return { artifactKey, summary };
  }
}
