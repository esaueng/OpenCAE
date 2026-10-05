import type {
  OcctImportResult,
  OcctImporter,
  OcctTessellationParameters
} from "occt-import-js";

/**
 * Detailed viewport geometry is used while the model can be inspected or
 * zoomed. Balanced geometry is reserved for transient/offscreen work where
 * retaining the detailed triangle count would not improve the visible result.
 */
export type StepDisplayLod = "detailed" | "balanced";

export const STEP_DISPLAY_TESSELLATION_REVISION = 2;

const STEP_DISPLAY_TESSELLATION: Record<StepDisplayLod, Readonly<OcctTessellationParameters>> = {
  detailed: Object.freeze({
    linearUnit: "millimeter",
    linearDeflectionType: "bounding_box_ratio",
    // A ratio keeps chordal tolerance proportional to model size. On an
    // analytic cylinder this produces about 220 perimeter samples, keeping
    // the silhouette sub-pixel smooth at close inspection zooms.
    linearDeflection: 0.0001,
    angularDeflection: 0.12
  }),
  balanced: Object.freeze({
    linearUnit: "millimeter",
    linearDeflectionType: "bounding_box_ratio",
    // Still materially smoother than the importer default, but about 37%
    // fewer cylinder triangles than the detailed profile.
    linearDeflection: 0.00025,
    angularDeflection: 0.18
  })
};

export function stepDisplayTessellationParameters(
  lod: StepDisplayLod = "detailed"
): OcctTessellationParameters {
  return { ...STEP_DISPLAY_TESSELLATION[lod] };
}

export function readStepFileForDisplay(
  importer: OcctImporter,
  content: Uint8Array,
  lod: StepDisplayLod = "detailed"
): OcctImportResult {
  return importer.ReadStepFile(content, stepDisplayTessellationParameters(lod));
}

/**
 * Face registries cache tessellation-derived topology. Include both the
 * tessellation revision and a dual content digest so changing either the CAD
 * payload or display profile cannot reuse stale triangle ranges.
 */
export function stepDisplayCacheKey(
  contentBase64: string,
  lod: StepDisplayLod = "detailed"
): string {
  let djb2 = 5381;
  let fnv1a = 0x811c9dc5;
  for (let index = 0; index < contentBase64.length; index += 1) {
    const value = contentBase64.charCodeAt(index);
    djb2 = ((djb2 << 5) + djb2 + value) | 0;
    fnv1a ^= value;
    fnv1a = Math.imul(fnv1a, 0x01000193);
  }
  return [
    `v${STEP_DISPLAY_TESSELLATION_REVISION}`,
    lod,
    contentBase64.length,
    (djb2 >>> 0).toString(16),
    (fnv1a >>> 0).toString(16)
  ].join(":");
}
