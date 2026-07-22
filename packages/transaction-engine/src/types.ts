import type { HistoryGraph } from "@kineweave/history-engine";
import type {
  Diagnostic,
  HistoryCommit,
  JsonObject,
  Operation,
  OperationPrecondition,
  ProjectDocumentEnvelope,
  TransactionProposal
} from "@kineweave/protocol";

export interface OperationReadContext {
  readDocument<TData extends JsonObject = JsonObject>(
    documentId: string
  ): ProjectDocumentEnvelope<TData> | undefined;
  documentHash(documentId: string): string | null;
  listDocumentIds(): readonly string[];
}

export type DocumentMutation =
  | {
      readonly kind: "create";
      readonly documentId: string;
      readonly document: ProjectDocumentEnvelope<JsonObject>;
    }
  | {
      readonly kind: "replace";
      readonly documentId: string;
      readonly document: ProjectDocumentEnvelope<JsonObject>;
    }
  | {
      readonly kind: "delete";
      readonly documentId: string;
    };

export interface OperationEffect {
  readonly mutations?: readonly DocumentMutation[];
  readonly diagnostics?: readonly Diagnostic[];
}

export interface OperationHandler {
  readonly operationType: string;
  readonly schemaVersion: number;
  prepare(
    operation: Operation,
    context: OperationReadContext
  ): OperationEffect | Promise<OperationEffect>;
}

export interface DocumentValidator {
  readonly documentType: string;
  readonly schemaVersion: number;
  validate(
    document: ProjectDocumentEnvelope<JsonObject>,
    context: OperationReadContext
  ): readonly Diagnostic[] | Promise<readonly Diagnostic[]>;
}

export type CrossDocumentValidator = (
  context: OperationReadContext,
  changedDocumentIds: ReadonlySet<string>
) => readonly Diagnostic[] | Promise<readonly Diagnostic[]>;

export type PreconditionEvaluator = (
  precondition: OperationPrecondition,
  context: OperationReadContext
) => Diagnostic | undefined | Promise<Diagnostic | undefined>;

export interface TransactionContributionRegistry {
  registerOperationHandler(handler: OperationHandler): () => void;
  registerDocumentValidator(validator: DocumentValidator): () => void;
  registerCrossDocumentValidator(validator: CrossDocumentValidator): () => void;
  registerPrecondition(type: string, evaluator: PreconditionEvaluator): () => void;
}

export interface TransactionEngineHost {
  readonly now: () => Date;
  readonly createCommitId: () => string;
}

export interface TransactionEngineOptions {
  readonly history: HistoryGraph;
  readonly host: TransactionEngineHost;
}

export interface TransactionExecutionResult {
  readonly commit: HistoryCommit;
  readonly proposal: TransactionProposal;
}
