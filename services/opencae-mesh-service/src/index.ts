import type { MeshSummary, Study } from "@opencae/schema";
import type { ObjectStorageProvider } from "@opencae/storage";

export class MockMeshService {
  constructor(private readonly storage: ObjectStorageProvider) {}

  async generateMesh(study: Study, preset: "coarse" | "medium" | "fine"): Promise<{ artifactKey: string; summary: MeshSummary }> {
    const summaryByPreset: Record<typeof preset, MeshSummary> = {
      coarse: { nodes: 12840, elements: 7320, warnings: [] },
      medium: { nodes: 42381, elements: 26944, warnings: ["Small feature simplified for the mock mesh."] },
      fine: { nodes: 88420, elements: 57102, warnings: ["Fine preset is mocked; no native mesher was run."] }
    };
    const summary = summaryByPreset[preset];
    const artifactKey = `${study.projectId}/mesh/mesh-summary.json`;
    await this.storage.putObject(artifactKey, JSON.stringify(summary, null, 2));
    return { artifactKey, summary };
  }
}
