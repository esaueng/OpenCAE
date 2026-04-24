import type { DisplayModel } from "@opencae/schema";
import type { ObjectStorageProvider } from "@opencae/storage";
import { bracketDisplayModel } from "@opencae/db/sample-data";

export async function inspectStepFile(storage: ObjectStorageProvider): Promise<{ artifactKey: string; displayModel: DisplayModel }> {
  const artifactKey = "project-bracket-demo/geometry/bracket-display.json";
  await storage.putObject(artifactKey, JSON.stringify(bracketDisplayModel, null, 2));
  return { artifactKey, displayModel: bracketDisplayModel };
}
