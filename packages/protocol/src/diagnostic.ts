import type { JsonObject } from "./json.js";

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly resourceUri?: string;
  readonly jsonPointer?: string;
  readonly documentId?: string;
  readonly source?: string;
  readonly details?: JsonObject;
}

export function hasErrorDiagnostics(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}
