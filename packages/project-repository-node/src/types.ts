import type {
  Diagnostic,
  JsonObject,
  KineWeaveHistory,
  KineWeaveLockfile,
  KineWeaveProjectManifest,
  ProjectDocumentEnvelope
} from "@kineweave/protocol";

export interface LoadedProjectBundle {
  readonly manifest: KineWeaveProjectManifest;
  readonly lockfile: KineWeaveLockfile;
  readonly history: KineWeaveHistory;
  readonly documents: Readonly<
    Record<string, ProjectDocumentEnvelope<JsonObject>>
  >;
}

export interface ProjectSnapshot {
  readonly rootPath: string;
  readonly bundle: LoadedProjectBundle;
  readonly fileHashes: Readonly<Record<string, string>>;
}

export interface ProjectReadResult {
  readonly snapshot?: ProjectSnapshot;
  readonly diagnostics: readonly Diagnostic[];
}

export type RepositoryTransactionPhase =
  | "prepared"
  | "before-apply"
  | "after-apply"
  | "committed"
  | "rolled-back";

export interface RepositoryTransactionEvent {
  readonly transactionId: string;
  readonly phase: RepositoryTransactionPhase;
  readonly relativePath?: string;
  readonly entryIndex?: number;
}

export interface NodeProjectRepositoryOptions {
  readonly onTransactionEvent?: (
    event: RepositoryTransactionEvent
  ) => void | Promise<void>;
}

export interface RecoveryReport {
  readonly recoveredTransactions: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}
