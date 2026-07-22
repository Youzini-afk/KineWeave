import type { Diagnostic } from "@kineweave/protocol";

export class ProjectRepositoryError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(message: string, diagnostics: readonly Diagnostic[]) {
    super(message);
    this.name = "ProjectRepositoryError";
    this.diagnostics = diagnostics;
  }
}
