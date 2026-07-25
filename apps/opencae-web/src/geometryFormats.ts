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

function formatList(items: readonly string[]): string {
  if (items.length < 2) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")}, or ${items[items.length - 1]}`;
}
