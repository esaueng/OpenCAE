import type { DisplayModel, Project } from "@opencae/schema";

/**
 * The current procedural solver geometry for the Bracket Demo sample. Lives
 * here (not in localProjectFactory) so both project-open and autosave-restore
 * paths can migrate persisted saves without an import cycle through
 * appPersistence.
 */
export const BRACKET_CORE_CLOUD_GEOMETRY = {
  kind: "sample_procedural" as const,
  sampleId: "bracket" as const,
  units: "mm" as const,
  descriptor: {
    base: { length: 120, width: 34, height: 10 },
    upright: { height: 88, width: 18, thickness: 34 },
    // Thickness < base width makes the gusset a thin centered rib (matching the
    // displayed bracket, whose rib is 0.38/1.1 of the 34 mm body depth). A full
    // 34 mm gusset fills the bracket's inside corner into a solid wedge, so the
    // solved/rendered result stops resembling the displayed model. The rib is
    // also kept short and the flange bores placed beyond it: a bore under the
    // rib intersects it (the bore cut overshoots 1 mm past the base top), and
    // the resulting sliver elements fail the mesher's minSICN quality floor.
    gusset: { length: 40, height: 40, thickness: 12 },
    rib: { length: 40, height: 40, thickness: 12 },
    holes: [
      { id: "hole-base-1", center: [68, 17, 5], diameter: 12 },
      { id: "hole-base-2", center: [100, 17, 5], diameter: 12 },
      { id: "hole-upright-1", center: [9, 17, 56], diameter: 10 }
    ],
    surfaces: {
      fixedSupport: { selectionRef: "selection-fixed-face", sourceSelectionRef: "FS1", sourceFaceId: "face-base-left", name: "fixed_support" },
      loadSurface: { selectionRef: "selection-load-face", sourceSelectionRef: "L1", sourceFaceId: "face-load-top", name: "load_surface" }
    },
    supportFaceId: "face-base-left",
    loadFaceId: "face-load-top",
    meshSize: 18
  }
};

export const BRACKET_GEOMETRY_MIGRATION_NOTE =
  "Note: this project carried an outdated Bracket Demo geometry; it was refreshed to the corrected bracket shape and any stored mesh was cleared, so re-mesh before the next run.";

export interface BracketGeometryMigration {
  project: Project;
  displayModel: DisplayModel | null;
  migrated: boolean;
}

/**
 * Persisted Bracket Demo projects embed the procedural solver geometry at
 * creation time, so descriptor fixes never reach existing saves on their own:
 * a project saved with the old full-width-gusset descriptor keeps solving and
 * rendering the wedge even on fixed builds (geometrySourceForStudy prefers the
 * persisted displayModel.coreCloudGeometry, and the stored mesh artifact under
 * meshSettings.summary.artifacts was meshed from the old shape). Refresh both
 * embedded copies to the current descriptor and drop the now-mismatched mesh
 * so the next run re-meshes the corrected geometry. Callers must surface
 * BRACKET_GEOMETRY_MIGRATION_NOTE when `migrated` is true - no silent
 * migrations.
 */
export function refreshBracketSampleGeometry(project: Project, displayModel: DisplayModel | null = null): BracketGeometryMigration {
  if (!project.geometryFiles.some(isBracketSampleGeometry)) return { project, displayModel, migrated: false };

  let metadataStale = false;
  const geometryFiles = project.geometryFiles.map((geometry) => {
    if (!isBracketSampleGeometry(geometry) || deepEquals(geometry.metadata.coreCloudGeometry, BRACKET_CORE_CLOUD_GEOMETRY)) return geometry;
    metadataStale = true;
    return { ...geometry, metadata: { ...geometry.metadata, coreCloudGeometry: BRACKET_CORE_CLOUD_GEOMETRY } };
  });

  const displayGeometry = displayModel?.coreCloudGeometry;
  const displayStale = Boolean(
    displayGeometry &&
    displayGeometry.kind === "sample_procedural" &&
    displayGeometry.sampleId === "bracket" &&
    !deepEquals(displayGeometry, BRACKET_CORE_CLOUD_GEOMETRY)
  );
  if (!metadataStale && !displayStale) return { project, displayModel, migrated: false };

  return {
    project: { ...project, geometryFiles, studies: project.studies.map(invalidateStoredMesh) },
    displayModel: displayStale && displayModel ? { ...displayModel, coreCloudGeometry: BRACKET_CORE_CLOUD_GEOMETRY } : displayModel,
    migrated: true
  };
}

function isBracketSampleGeometry(geometry: Project["geometryFiles"][number]): boolean {
  return geometry.metadata.sampleModel === "bracket";
}

/** The stored mesh (summary counts, artifacts.actualCoreModel) was meshed from the old shape; the run flow re-meshes when it is absent. */
function invalidateStoredMesh(study: Project["studies"][number]): Project["studies"][number] {
  const meshSettings = study.meshSettings;
  if (meshSettings.status === "not_started" && !meshSettings.meshRef && !meshSettings.summary) return study;
  return { ...study, meshSettings: { preset: meshSettings.preset, status: "not_started" } };
}

function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEquals(item, b[index]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const leftKeys = Object.keys(left);
    return leftKeys.length === Object.keys(right).length && leftKeys.every((key) => deepEquals(left[key], right[key]));
  }
  return false;
}
