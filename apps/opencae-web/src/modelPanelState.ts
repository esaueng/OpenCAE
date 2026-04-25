export interface ModelPanelProjectState {
  geometryFiles: Array<{ metadata?: Record<string, unknown> }>;
}

export function shouldShowSampleModelPicker(project: ModelPanelProjectState) {
  return project.geometryFiles.some((file) => file.metadata?.source === "sample" || typeof file.metadata?.sampleModel === "string");
}
