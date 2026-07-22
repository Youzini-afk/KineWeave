import type { EvaluationContributionRegistry } from "@kineweave/evaluation-engine";
import type { ExtensionManifest, HostKind } from "@kineweave/protocol";
import type { RendererContributionRegistry } from "@kineweave/render-engine";
import type { TransactionContributionRegistry } from "@kineweave/transaction-engine";

export interface KineWeaveExtensionContext {
  readonly manifest: ExtensionManifest;
  readonly hostKind: HostKind;
  readonly transactions: TransactionContributionRegistry;
  readonly evaluation: EvaluationContributionRegistry;
  readonly rendering: RendererContributionRegistry;
}
