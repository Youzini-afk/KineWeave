import {
  EvaluationEngine,
  type EvaluationExecutionResult
} from "@kineweave/evaluation-engine";
import {
  createKineWeaveExtensionContributionAudit,
  type KineWeaveExtensionContributionAudit,
  type KineWeaveExtensionContext
} from "@kineweave/extension-api";
import { ExtensionHost } from "@kineweave/extension-host";
import {
  HistoryGraph,
  type BranchRef,
  type DocumentState
} from "@kineweave/history-engine";
import type { LoadedProjectBundle } from "@kineweave/project-format";
import {
  hasErrorDiagnostics,
  type Diagnostic,
  type EvaluationRequest,
  type JsonObject,
  type ProjectDocumentEnvelope,
  type TransactionProposal
} from "@kineweave/protocol";
import {
  RenderEngine,
  type RenderExecutionRequest,
  type RenderExecutionResult
} from "@kineweave/render-engine";
import {
  TransactionEngine,
  type TransactionExecutionResult
} from "@kineweave/transaction-engine";
import type { ProjectSessionOpenResult, ProjectSessionOptions } from "./types.js";

function lockedExtensionVersions(
  bundle: LoadedProjectBundle
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(bundle.lockfile.extensions).map(([extensionId, extension]) => [
      extensionId,
      extension.version
    ])
  );
}

function initialDocumentState(bundle: LoadedProjectBundle): DocumentState {
  return Object.fromEntries(
    Object.entries(bundle.documents).map(([documentId, document]) => [
      documentId,
      document as unknown as JsonObject
    ])
  );
}

function extensionRequirements(bundle: LoadedProjectBundle) {
  return Object.fromEntries(
    Object.entries(bundle.manifest.extensionRequirements).map(
      ([extensionId, requirement]) => [
        extensionId,
        {
          versionRange: requirement.versionRange,
          ...(requirement.optional === undefined
            ? {}
            : { optional: requirement.optional })
        }
      ]
    )
  );
}

function sessionDiagnostic(code: string, message: string): Diagnostic {
  return {
    severity: "error",
    code,
    message,
    source: "@kineweave/project-session"
  };
}

export class ProjectSession {
  readonly history: HistoryGraph;
  readonly transactions: TransactionEngine;
  readonly evaluation: EvaluationEngine;
  readonly rendering: RenderEngine;
  readonly extensions: ExtensionHost<KineWeaveExtensionContext>;
  readonly #baseBundle: LoadedProjectBundle;
  #disposed = false;

  private constructor(
    bundle: LoadedProjectBundle,
    history: HistoryGraph,
    transactions: TransactionEngine,
    evaluation: EvaluationEngine,
    rendering: RenderEngine,
    extensions: ExtensionHost<KineWeaveExtensionContext>
  ) {
    this.#baseBundle = structuredClone(bundle);
    this.history = history;
    this.transactions = transactions;
    this.evaluation = evaluation;
    this.rendering = rendering;
    this.extensions = extensions;
  }

  static async open(
    options: ProjectSessionOptions
  ): Promise<ProjectSessionOpenResult<ProjectSession>> {
    const diagnostics: Diagnostic[] = [];
    let history: HistoryGraph;
    try {
      history = HistoryGraph.fromSnapshot(options.bundle.history);
    } catch (error) {
      return {
        diagnostics: [
          sessionDiagnostic(
            "session.history.invalid",
            error instanceof Error ? error.message : String(error)
          )
        ]
      };
    }
    const evaluation = new EvaluationEngine({
      host: {
        resolveState(reference) {
          if (reference === undefined) {
            return history.stateOfBranch(history.mainBranchName);
          }
          return reference.kind === "branch"
            ? history.stateOfBranch(reference.branchName)
            : history.stateAt(reference.commitId);
        }
      }
    });
    const rendering = new RenderEngine({
      environment: {
        hostKind: options.host.hostKind,
        ...options.host.environment
      },
      lockedBindings: options.bundle.lockfile.capabilityBindings,
      distributionDefaults: options.distribution.descriptor.capabilityDefaults
    });
    const transactions = new TransactionEngine({
      history,
      host: {
        createCommitId: options.host.createCommitId,
        now: options.host.now
      }
    });
    const audits = new Map<string, KineWeaveExtensionContributionAudit>();
    const extensions = new ExtensionHost<KineWeaveExtensionContext>({
      kineweaveVersion: options.kineweaveVersion,
      hostKind: options.host.hostKind,
      supportedRuntimes: options.host.supportedRuntimes,
      createActivationContext(manifest) {
        const audit = createKineWeaveExtensionContributionAudit({
          manifest,
          hostKind: options.host.hostKind,
          transactions,
          evaluation,
          rendering
        });
        audits.set(manifest.extensionId, audit);
        return audit.context;
      }
    });
    for (const source of options.distribution.extensions) extensions.discover(source);

    const plan = extensions.resolve({
      requirements: extensionRequirements(options.bundle),
      lockedVersions: lockedExtensionVersions(options.bundle)
    });
    diagnostics.push(...plan.diagnostics);
    if (!hasErrorDiagnostics(diagnostics)) {
      try {
        await extensions.activate(plan);
      } catch (error) {
        const activationDiagnostics = extensions
          .statuses()
          .flatMap((status) =>
            status.diagnostic === undefined ? [] : [status.diagnostic]
          );
        diagnostics.push(
          ...(activationDiagnostics.length > 0
            ? activationDiagnostics
            : [
                sessionDiagnostic(
                  "session.extension.activation-failed",
                  error instanceof Error ? error.message : String(error)
                )
              ])
        );
      }
    }
    if (!hasErrorDiagnostics(diagnostics)) {
      for (const resolved of plan.extensions) {
        const audit = audits.get(resolved.manifest.extensionId);
        if (audit !== undefined) diagnostics.push(...audit.diagnostics());
      }
    }
    if (!hasErrorDiagnostics(diagnostics)) {
      diagnostics.push(...(await transactions.validateState(initialDocumentState(options.bundle))));
    }
    if (hasErrorDiagnostics(diagnostics)) {
      try {
        await extensions.deactivateAll();
      } catch (error) {
        diagnostics.push(
          sessionDiagnostic(
            "session.extension.rollback-failed",
            error instanceof Error ? error.message : String(error)
          )
        );
      }
      return { diagnostics };
    }

    return {
      session: new ProjectSession(
        options.bundle,
        history,
        transactions,
        evaluation,
        rendering,
        extensions
      ),
      diagnostics
    };
  }

  execute(proposal: TransactionProposal): Promise<TransactionExecutionResult> {
    this.#assertOpen();
    return this.transactions.execute(proposal);
  }

  evaluate(request: EvaluationRequest): Promise<EvaluationExecutionResult> {
    this.#assertOpen();
    return this.evaluation.evaluate(request);
  }

  render(request: RenderExecutionRequest): Promise<RenderExecutionResult> {
    this.#assertOpen();
    return this.rendering.render(request);
  }

  undo(branchName = this.history.mainBranchName): BranchRef | undefined {
    this.#assertOpen();
    return this.history.undo(branchName);
  }

  redo(branchName = this.history.mainBranchName, commitId?: string): BranchRef | undefined {
    this.#assertOpen();
    return this.history.redo(branchName, commitId);
  }

  createBranch(branchName: string, fromCommitId?: string): BranchRef {
    this.#assertOpen();
    return this.history.createBranch(branchName, fromCommitId);
  }

  deleteBranch(branchName: string): void {
    this.#assertOpen();
    this.history.deleteBranch(branchName);
  }

  toBundle(): LoadedProjectBundle {
    this.#assertOpen();
    const mainState = this.history.stateOfBranch(this.history.mainBranchName);
    return {
      ...structuredClone(this.#baseBundle),
      history: this.history.toSnapshot(),
      documents: Object.fromEntries(
        Object.entries(mainState).map(([documentId, document]) => [
          documentId,
          document as unknown as ProjectDocumentEnvelope<JsonObject>
        ])
      )
    };
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    await this.extensions.deactivateAll();
    this.#disposed = true;
  }

  #assertOpen(): void {
    if (this.#disposed) throw new Error("Project session is disposed");
  }
}
