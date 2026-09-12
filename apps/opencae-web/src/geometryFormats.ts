/**
 * One source for the geometry formats the app imports.
 *
 * The file input accepted `.obj` while the upload help text listed only STEP,
 * STP, and STL — three independent copies of the same list, and one of them
 * went stale when OBJ support landed. Everything that names a supported format
 * derives it from here.
 */
export const SUPPORTED_GEOMETRY_EXTENSIONS = ["step", "stp", "stl", "obj"] as const;

export type SupportedGeometryExtension = (typeof SUPPORTED_GEOMETRY_EXTENSIONS)[number];

/** `accept` attribute value for a geometry file input. */
export const GEOMETRY_FILE_ACCEPT = SUPPORTED_GEOMETRY_EXTENSIONS.map((extension) => `.${extension}`).join(",");

/** Human-readable list for help text and errors, e.g. "STEP, STP, STL, or OBJ". */
export const SUPPORTED_GEOMETRY_FORMAT_LABEL = formatList(SUPPORTED_GEOMETRY_EXTENSIONS.map((extension) => extension.toUpperCase()));

export function isSupportedGeometryExtension(value: string): value is SupportedGeometryExtension {
  return (SUPPORTED_GEOMETRY_EXTENSIONS as readonly string[]).includes(value.toLowerCase());
}

/**
 * STL and OBJ imports are triangle-mesh previews: they have no B-rep to
 * volume-mesh, so a study on them can never be solved in the browser. Both
 * the run gate and the Mesh panel use this so the dead end is announced at
 * import instead of after a run (2026-09 review D6).
 */
export function isPreviewOnlyGeometry(displayModel: { nativeCad?: unknown; visualMesh?: { format: string } | undefined } | null | undefined): boolean {
  if (!displayModel) return false;
  return Boolean(displayModel.visualMesh) && !displayModel.nativeCad;
}

export const PREVIEW_ONLY_GEOMETRY_NOTICE = "STL and OBJ files are viewport previews only: OpenCAE cannot build a volume mesh from a triangle mesh, so this model cannot be meshed or solved. Import STEP to simulate.";

function formatList(items: readonly string[]): string {
  if (items.length < 2) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}
