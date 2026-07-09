// Heals projects whose STEP upload happened while the B-rep face registry was
// unavailable (the June–July 2026 production CSP regression blocked
// occt-import-js, so uploads fell back to the legacy generic box faces).
// Those projects persist supports/loads that reference "face-upload-*"
// placeholders, which can never map onto the meshed STEP geometry — every
// mesh generation dies at the Core-artifact step with "could not map
// selection ...". Once the registry works again we rebuild the real faces,
// remap selections whose placeholder normal dominantly matches one real
// B-rep face, and name anything ambiguous for manual re-selection instead of
// silently guessing at physics.
import type { DisplayFace, DisplayModel, Project } from "@opencae/schema";
import type { StepFaceRegistry } from "./stepFaces";

export const LEGACY_UPLOAD_FACE_PREFIX = "face-upload-";

/** Dominant-match gate: best |normal alignment| and its lead over the runner-up. */
const REMAP_MIN_ALIGNMENT = 0.8;
const REMAP_MIN_ALIGNMENT_MARGIN = 0.1;

export type LegacyStepFaceHeal = {
  project: Project;
  displayModel: DisplayModel;
  /** Selections remapped onto a dominant real face: "FS 1 → Bottom-most face (step-face-3)". */
  remapped: Array<{ selectionName: string; fromFaceId: string; toFaceId: string; toLabel: string }>;
  /** Selections whose placeholder face had no dominant real match; the user must re-pick them. */
  unresolved: Array<{ selectionName: string; fromFaceId: string }>;
};

/**
 * True when the display model is a STEP import that still carries only the
 * legacy generic box faces — the marker that the upload ran without a face
 * registry and any persisted face selections point at placeholders.
 */
export function hasLegacyStepUploadFaces(displayModel: DisplayModel | null | undefined): displayModel is DisplayModel {
  if (!displayModel?.nativeCad?.contentBase64 || displayModel.nativeCad.format !== "step") return false;
  if (!displayModel.faces.length) return false;
  return displayModel.faces.every((face) => face.id.startsWith(LEGACY_UPLOAD_FACE_PREFIX));
}

/**
 * Pure heal: swap the placeholder faces for the registry's real display faces
 * and remap face selections. Placeholder centers/normals and registry display
 * faces share the normalized viewer frame, so normal alignment is meaningful.
 */
export function healLegacyStepFaces(project: Project, displayModel: DisplayModel, registry: StepFaceRegistry): LegacyStepFaceHeal {
  const legacyFacesById = new Map(displayModel.faces.map((face) => [face.id, face]));
  const remapped: LegacyStepFaceHeal["remapped"] = [];
  const unresolved: LegacyStepFaceHeal["unresolved"] = [];

  const studies = project.studies.map((study) => ({
    ...study,
    namedSelections: study.namedSelections.map((selection) => {
      if (selection.entityType !== "face") return selection;
      const legacyRef = selection.geometryRefs.find((ref) => ref.entityType === "face" && ref.entityId.startsWith(LEGACY_UPLOAD_FACE_PREFIX));
      if (!legacyRef) return selection;
      const legacyFace = legacyFacesById.get(legacyRef.entityId);
      const match = legacyFace ? dominantFaceForNormal(registry.displayFaces, legacyFace.normal) : null;
      if (!match) {
        unresolved.push({ selectionName: selection.name, fromFaceId: legacyRef.entityId });
        return selection;
      }
      remapped.push({ selectionName: selection.name, fromFaceId: legacyRef.entityId, toFaceId: match.id, toLabel: match.label });
      return {
        ...selection,
        geometryRefs: selection.geometryRefs.map((ref) =>
          ref === legacyRef ? { ...ref, entityId: match.id, label: match.label } : ref
        ),
        fingerprint: `${match.id}-${match.center.map((value) => value.toFixed(3)).join("-")}`
      };
    })
  }));

  return {
    project: { ...project, studies },
    displayModel: { ...displayModel, faces: registry.displayFaces },
    remapped,
    unresolved
  };
}

/** One-line log message describing what the heal did, or null when nothing was selected on placeholders. */
export function legacyStepFaceHealMessage(heal: LegacyStepFaceHeal): string | null {
  const parts: string[] = [];
  if (heal.remapped.length) {
    const moves = heal.remapped.map((item) => `${item.selectionName} → ${item.toLabel}`).join(", ");
    parts.push(`Remapped to real STEP faces: ${moves}. Review them before running.`);
  }
  if (heal.unresolved.length) {
    const names = heal.unresolved.map((item) => item.selectionName).join(", ");
    parts.push(`Re-select on the model (no confident match): ${names}.`);
  }
  if (!parts.length) return null;
  return `This project was saved before STEP faces were available. ${parts.join(" ")}`;
}

function dominantFaceForNormal(faces: DisplayFace[], normal: [number, number, number]): DisplayFace | null {
  let best: DisplayFace | null = null;
  let bestScore = -Infinity;
  let runnerUpScore = -Infinity;
  for (const face of faces) {
    const score = dot(face.normal, normal);
    if (score > bestScore) {
      runnerUpScore = bestScore;
      bestScore = score;
      best = face;
    } else if (score > runnerUpScore) {
      runnerUpScore = score;
    }
  }
  if (!best || bestScore < REMAP_MIN_ALIGNMENT) return null;
  if (bestScore - runnerUpScore < REMAP_MIN_ALIGNMENT_MARGIN) return null;
  return best;
}

function dot(left: [number, number, number], right: [number, number, number]): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}
