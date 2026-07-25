import { validateStudy } from "@opencae/study-core";
import type { CustomMaterial, Diagnostic, Study } from "@opencae/schema";

export interface RunReadinessItem {
  label: string;
  done: boolean;
  /** Validator messages that keep this item from being done. */
  blockers: string[];
}

/**
 * Readiness groups, most specific prefix first — the first group that claims a
 * diagnostic owns it. Order matters: `validation-dynamic-support` is a support
 * problem, not a solver-settings problem, so the support group must be tried
 * before the settings group.
 */
const READINESS_GROUPS: ReadonlyArray<{ label: string; prefixes: readonly string[] }> = [
  { label: "Material assigned", prefixes: ["validation-material"] },
  {
    label: "Support added",
    prefixes: ["validation-support", "validation-modal-support", "validation-dynamic-support", "validation-thermal-support"]
  },
  { label: "Load added", prefixes: ["validation-load", "validation-thermal-load", "validation-combination"] },
  { label: "Mesh generated", prefixes: ["validation-mesh"] },
  { label: "Run settings valid", prefixes: ["validation-dynamic", "validation-modal-mode-count"] }
];

const ALWAYS_SHOWN = new Set(["Material assigned", "Support added", "Load added", "Mesh generated"]);

/**
 * The Run gate, derived from the domain validator rather than from a parallel
 * set of presence checks.
 *
 * The presence checks this replaced ("a load exists") passed a load of -1 N
 * straight through to a solver that then rejected it. `validateStudy` already
 * knew the rule; nothing called it. Deriving readiness from its diagnostics is
 * what keeps the two from drifting apart again.
 */
export function readinessForStudy(study: Study | null, customMaterials: readonly CustomMaterial[] = []): RunReadinessItem[] {
  if (!study) return READINESS_GROUPS.filter((group) => ALWAYS_SHOWN.has(group.label)).map((group) => ({ label: group.label, done: false, blockers: [] }));

  const diagnostics = validateStudy(study, customMaterials);
  const claimed = new Map<string, string[]>();
  const unclaimed: string[] = [];
  for (const diagnostic of diagnostics) {
    const group = READINESS_GROUPS.find((candidate) => candidate.prefixes.some((prefix) => matchesPrefix(diagnostic, prefix)));
    if (!group) {
      unclaimed.push(diagnostic.message);
      continue;
    }
    claimed.set(group.label, [...(claimed.get(group.label) ?? []), diagnostic.message]);
  }

  const items = READINESS_GROUPS.flatMap((group) => {
    // Modal analysis runs on stiffness and mass alone; a load row would always
    // read as done and tell the user nothing.
    if (group.label === "Load added" && study.type === "modal_analysis") return [];
    const blockers = claimed.get(group.label) ?? [];
    // Settings rows only earn a place in the checklist once they have something
    // to say; the four core steps are always part of the workflow.
    if (!ALWAYS_SHOWN.has(group.label) && !blockers.length) return [];
    return [{ label: group.label, done: blockers.length === 0, blockers }];
  });

  // A diagnostic no group claims must still block the run — silently dropping
  // it would let a new validator rule pass the gate it was written to close.
  return unclaimed.length ? [...items, { label: "Study valid", done: false, blockers: unclaimed }] : items;
}

function matchesPrefix(diagnostic: Diagnostic, prefix: string): boolean {
  return diagnostic.id === prefix || diagnostic.id.startsWith(`${prefix}-`);
}
