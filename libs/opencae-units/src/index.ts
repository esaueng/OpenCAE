export type UnitSystem = "SI" | "US";

export function formatEngineeringValue(value: number, units: string): string {
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 3 })} ${units}`.trim();
}
