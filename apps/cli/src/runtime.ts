import { randomUUID } from "node:crypto";
import { EvaluationEngine } from "@kineweave/evaluation-engine";
import type { KineWeaveExtensionContext } from "@kineweave/extension-api";
import { ExtensionHost } from "@kineweave/extension-host";
import { HistoryGraph } from "@kineweave/history-engine";
import type { ProjectSnapshot } from "@kineweave/project-repository-node";
import { RenderEngine } from "@kineweave/render-engine";
import {
  hasErrorDiagnostics,
  type Diagnostic,
  type JsonObject
} from "@kineweave/protocol";
import {
  activateStandardMotionExtension,
  standardMotionExtensionManifest
} from "@kineweave/standard-motion-document";
import {
  activateSvgRendererExtension,
  svgRendererExtensionManifest
} from "@kineweave/svg-renderer";
import { TransactionEngine } from "@kineweave/transaction-engine";

const KINEWEAVE_VERSION = "0.1.0";

export interface ProjectRuntime {
  readonly history: HistoryGraph;
  readonly engine: TransactionEngine;
  readonly evaluation: EvaluationEngine;
  readonly rendering: RenderEngine;
  readonly extensions: ExtensionHost<KineWeaveExtensionContext>;
  dispose(): Promise<void>;
}

export interface ProjectRuntimeBootstrap {
  readonly runtime: ProjectRuntime;
  readonly diagnostics: readonly Diagnostic[];
}

function lockedExtensionVersions(
  snapshot: ProjectSnapshot
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(snapshot.bundle.lockfile.extensions).map(
      ([extensionId, extension]) => [extensionId, extension.version]
    )
  );
}

export async function bootstrapProjectRuntime(
  snapshot: ProjectSnapshot
): Promise<ProjectRuntimeBootstrap> {
  const initialDocuments = Object.fromEntries(
    Object.entries(snapshot.bundle.documents).map(([documentId, document]) => [
      documentId,
      document as unknown as JsonObject
    ])
  );
  const history = HistoryGraph.fromSnapshot(snapshot.bundle.history);
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
      hostKind: "cli",
      operatingSystem: process.platform,
      architecture: process.arch
    },
    lockedBindings: snapshot.bundle.lockfile.capabilityBindings
  });
  const engine = new TransactionEngine({
    history,
    host: {
      createCommitId: () => `commit_${randomUUID().replaceAll("-", "")}`,
      now: () => new Date()
    }
  });
  const extensions = new ExtensionHost<KineWeaveExtensionContext>({
    kineweaveVersion: KINEWEAVE_VERSION,
    hostKind: "cli",
    supportedRuntimes: ["worker"],
    createActivationContext: (manifest) => ({
      manifest,
      hostKind: "cli",
      transactions: engine,
      evaluation,
      rendering
    })
  });
  extensions.discover({
    manifest: standardMotionExtensionManifest,
    load: () => ({ activate: activateStandardMotionExtension })
  });
  extensions.discover({
    manifest: svgRendererExtensionManifest,
    load: () => ({ activate: activateSvgRendererExtension })
  });

  const plan = extensions.resolve({
    requirements: snapshot.bundle.manifest.extensionRequirements,
    lockedVersions: lockedExtensionVersions(snapshot)
  });
  const diagnostics: Diagnostic[] = [...plan.diagnostics];
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
              {
                severity: "error" as const,
                code: "cli.extension.activation-failed",
                message: error instanceof Error ? error.message : String(error),
                source: "@kineweave/cli"
              }
            ])
      );
    }
  }
  if (!hasErrorDiagnostics(diagnostics)) {
    diagnostics.push(...(await engine.validateState(initialDocuments)));
  }

  return {
    runtime: {
      history,
      engine,
      evaluation,
      rendering,
      extensions,
      dispose: () => extensions.deactivateAll()
    },
    diagnostics
  };
}
