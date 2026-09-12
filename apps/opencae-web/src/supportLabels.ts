import type { Constraint, Load } from "@opencae/schema";

/**
 * Entry labels are assigned once, at creation, and stored in `parameters.label`
 * (2026-09 review F2, stable ids). They used to be derived from an entry's
 * position among its type, so changing FS 1 to a prescribed type renamed FS 2
 * to FS 1 and every note, log line and callout that said "FS 2" drifted.
 * Entries created before the label existed fall back to the ordinal.
 */
export function storedEntryLabel(entry: { parameters?: Record<string, unknown> }): string | undefined {
  const label = entry.parameters?.label;
  return typeof label === "string" && label.trim() ? label.trim() : undefined;
}

export function supportLabelPrefix(type: Constraint["type"]): string {
  return type === "fixed" ? "FS" : "PD";
}

export function supportDisplayLabel(support: Pick<Constraint, "type"> & { parameters?: Record<string, unknown> }, ordinal: number) {
  return storedEntryLabel(support) ?? `${supportLabelPrefix(support.type)} ${ordinal}`;
}

/** The next free label for a new support of `type`, never reusing one already on the study. */
export function nextSupportLabel(constraints: readonly Constraint[], type: Constraint["type"]): string {
  const prefix = supportLabelPrefix(type);
  const ordinals = new Map<string, number>();
  const used = constraints.map((support) => {
    const supportPrefix = supportLabelPrefix(support.type);
    const ordinal = (ordinals.get(supportPrefix) ?? 0) + 1;
    ordinals.set(supportPrefix, ordinal);
    return supportDisplayLabel(support, ordinal);
  });
  return nextFreeLabel(used, `${prefix} `);
}

/** The next free load label (`L1`, `L2`, …), never reusing one already on the study. */
export function nextLoadLabel(loads: readonly Load[]): string {
  const used = loads.map((load, index) => storedEntryLabel(load) ?? `L${index + 1}`);
  return nextFreeLabel(used, "L");
}

function nextFreeLabel(used: readonly string[], prefix: string): string {
  let highest = 0;
  for (const label of used) {
    if (!label.startsWith(prefix)) continue;
    const ordinal = Number(label.slice(prefix.length));
    if (Number.isInteger(ordinal) && ordinal > highest) highest = ordinal;
  }
  return `${prefix}${highest + 1}`;
}
