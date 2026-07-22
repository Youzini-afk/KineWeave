import type { Diagnostic } from "./diagnostic.js";
import type { JsonObject, JsonValue } from "./json.js";
import type { ResourceUri } from "./resource-uri.js";

export interface OperationPrecondition {
  readonly type: string;
  readonly schemaVersion: number;
  readonly payload: JsonValue;
}

export interface Operation {
  readonly operationId: string;
  readonly operationType: string;
  readonly schemaVersion: number;
  readonly targets: readonly ResourceUri[];
  readonly payload: JsonValue;
  readonly preconditions?: readonly OperationPrecondition[];
}

export type TransactionOriginKind = "user" | "ai" | "script" | "plugin";

export interface TransactionOrigin {
  readonly kind: TransactionOriginKind;
  readonly actorId?: string;
  readonly toolId?: string;
  readonly providerId?: string;
  readonly modelId?: string;
}

export interface TransactionProposal {
  readonly transactionId: string;
  readonly branchName: string;
  readonly origin: TransactionOrigin;
  readonly intent?: string;
  readonly operations: readonly Operation[];
  readonly metadata?: JsonObject;
}

export type JsonPatchOperation =
  | {
      readonly op: "add";
      readonly path: string;
      readonly value: JsonValue;
    }
  | {
      readonly op: "remove";
      readonly path: string;
    }
  | {
      readonly op: "replace";
      readonly path: string;
      readonly value: JsonValue;
    };

export interface DocumentPatch {
  readonly documentId: string;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly forward: readonly JsonPatchOperation[];
  readonly inverse: readonly JsonPatchOperation[];
}

export interface HistoryCommit {
  readonly commitId: string;
  readonly parentCommitIds: readonly string[];
  readonly transaction: TransactionProposal;
  readonly committedAt: string;
  readonly patches: readonly DocumentPatch[];
  readonly diagnostics: readonly Diagnostic[];
  readonly metadata?: JsonObject;
}
