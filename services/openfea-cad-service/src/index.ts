import type { DisplayModel } from "@openfea/schema";
import type { ObjectStorageProvider } from "@openfea/storage";
import { bracketDisplayModel } from "@openfea/db/sample-data";

export async function inspectStepFile(storage: ObjectStorageProvider): Promise<{ artifactKey: string; displayModel: DisplayModel }> {
  const artifactKey = "project-bracket-demo/geometry/bracket-display.json";
  await storage.putObject(artifactKey, JSON.stringify(bracketDisplayModel, null, 2));
  return { artifactKey, displayModel: bracketDisplayModel };
}
