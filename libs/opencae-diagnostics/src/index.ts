import type { Diagnostic } from "@opencae/schema";

export function infoDiagnostic(id: string, source: Diagnostic["source"], message: string): Diagnostic {
  return { id, source, message, severity: "info", suggestedActions: [] };
}
