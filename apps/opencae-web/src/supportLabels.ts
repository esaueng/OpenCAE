import type { Constraint } from "@opencae/schema";

export function supportDisplayLabel(support: Pick<Constraint, "type">, ordinal: number) {
  const prefix = support.type === "fixed" ? "FS" : "PD";
  return `${prefix} ${ordinal}`;
}
