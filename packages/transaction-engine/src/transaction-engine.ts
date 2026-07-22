import { hashJson } from "@kineweave/content-hash";
import {
  HistoryGraph,
  type DocumentState
} from "@kineweave/history-engine";
import { createDocumentPatch } from "@kineweave/patch";
import {
  cloneJson,
  hasErrorDiagnostics,
  parseResourceUri,
  type Diagnostic,
  type HistoryCommit,
  type JsonObject,
  type JsonValue,
  type Operation,
  type OperationPrecondition,
  type ProjectDocumentEnvelope,
  type TransactionProposal
} from "@kineweave/protocol";
import {
  validateDocumentEnvelopeSchema
} from "@kineweave/project-format";
import type {
  CrossDocumentValidator,
  DocumentMutation,
  DocumentValidator,
  OperationEffect,
  OperationHandler,
  OperationReadContext,
  PreconditionEvaluator,
  TransactionEngineOptions,
  TransactionContributionRegistry,
  TransactionExecutionResult
} from "./types.js";

export const BUILTIN_PRECONDITIONS = {
  documentExists: "org.kineweave.kernel/document-exists",
  documentHash: "org.kineweave.kernel/document-hash"
} as const;

export class TransactionRejectedError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(message: string, diagnostics: readonly Diagnostic[]) {
    super(message);
    this.name = "TransactionRejectedError";
    this.diagnostics = diagnostics;
  }
}

function diagnostic(
  code: string,
  message: string,
  jsonPointer?: string,
  documentId?: string
): Diagnostic {
  return {
    severity: "error",
    code,
    message,
    ...(jsonPointer === undefined ? {} : { jsonPointer }),
    ...(documentId === undefined ? {} : { documentId }),
    source: "@kineweave/transaction-engine"
  };
}

function handlerKey(type: string, schemaVersion: number): string {
  return `${type}@${schemaVersion}`;
}

function asDocument(
  value: JsonValue | undefined
): ProjectDocumentEnvelope<JsonObject> | undefined {
  return value === undefined
    ? undefined
    : (cloneJson(value) as unknown as ProjectDocumentEnvelope<JsonObject>);
}

class DraftReadContext implements OperationReadContext {
  constructor(
    readonly documents: Record<string, JsonValue>,
    readonly readSet: Set<string>
  ) {}

  readDocument<TData extends JsonObject = JsonObject>(
    documentId: string
  ): ProjectDocumentEnvelope<TData> | undefined {
    this.readSet.add(documentId);
    const document = asDocument(this.documents[documentId]);
    return document as ProjectDocumentEnvelope<TData> | undefined;
  }

  documentHash(documentId: string): string | null {
    this.readSet.add(documentId);
    const document = this.documents[documentId];
    return document === undefined ? null : hashJson(document);
  }

  listDocumentIds(): readonly string[] {
    return Object.keys(this.documents).sort();
  }
}

function parseObjectPayload(
  payload: JsonValue,
  preconditionType: string
):
  | { readonly ok: true; readonly value: JsonObject }
  | { readonly ok: false; readonly diagnostic: Diagnostic } {
  if (payload === null || Array.isArray(payload) || typeof payload !== "object") {
    return {
      ok: false,
      diagnostic: diagnostic(
        "transaction.precondition.payload-invalid",
        `Precondition ${preconditionType} requires an object payload`
      )
    };
  }
  return { ok: true, value: payload };
}

function validateProposal(proposal: TransactionProposal): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (proposal.operations.length === 0) {
    diagnostics.push(
      diagnostic(
        "transaction.operations.empty",
        "A transaction proposal requires at least one operation"
      )
    );
  }
  const operationIds = new Set<string>();
  for (const [index, operation] of proposal.operations.entries()) {
    if (operationIds.has(operation.operationId)) {
      diagnostics.push(
        diagnostic(
          "transaction.operation.id-duplicate",
          `Duplicate operation id ${operation.operationId}`,
          `/operations/${index}/operationId`
        )
      );
    }
    operationIds.add(operation.operationId);
    if (!Number.isSafeInteger(operation.schemaVersion) || operation.schemaVersion < 1) {
      diagnostics.push(
        diagnostic(
          "transaction.operation.schema-version-invalid",
          `Operation ${operation.operationId} has invalid schema version`,
          `/operations/${index}/schemaVersion`
        )
      );
    }
    for (const [targetIndex, target] of operation.targets.entries()) {
      try {
        const parsed = parseResourceUri(target);
        if (parsed.canonical !== target) {
          diagnostics.push(
            diagnostic(
              "transaction.operation.target-noncanonical",
              `Target must use canonical URI ${parsed.canonical}`,
              `/operations/${index}/targets/${targetIndex}`
            )
          );
        }
      } catch (error) {
        diagnostics.push(
          diagnostic(
            "transaction.operation.target-invalid",
            error instanceof Error ? error.message : String(error),
            `/operations/${index}/targets/${targetIndex}`
          )
        );
      }
    }
  }
  return diagnostics;
}

export class TransactionEngine implements TransactionContributionRegistry {
  readonly history: HistoryGraph;
  readonly #host: TransactionEngineOptions["host"];
  readonly #operationHandlers = new Map<string, OperationHandler>();
  readonly #documentValidators = new Map<string, DocumentValidator>();
  readonly #crossDocumentValidators: CrossDocumentValidator[] = [];
  readonly #preconditionEvaluators = new Map<string, PreconditionEvaluator>();

  constructor(options: TransactionEngineOptions) {
    this.history = options.history;
    this.#host = options.host;

    this.registerPrecondition(
      BUILTIN_PRECONDITIONS.documentExists,
      async (precondition, context) => {
        const parsed = parseObjectPayload(precondition.payload, precondition.type);
        if (!parsed.ok) return parsed.diagnostic;
        const { documentId, expected } = parsed.value;
        if (typeof documentId !== "string" || typeof expected !== "boolean") {
          return diagnostic(
            "transaction.precondition.payload-invalid",
            "document-exists requires string documentId and boolean expected"
          );
        }
        const exists = context.documentHash(documentId) !== null;
        return exists === expected
          ? undefined
          : diagnostic(
              "transaction.precondition.document-exists-failed",
              `Document ${documentId} existence is ${exists}, expected ${expected}`,
              undefined,
              documentId
            );
      }
    );

    this.registerPrecondition(
      BUILTIN_PRECONDITIONS.documentHash,
      async (precondition, context) => {
        const parsed = parseObjectPayload(precondition.payload, precondition.type);
        if (!parsed.ok) return parsed.diagnostic;
        const { documentId, expectedHash } = parsed.value;
        if (typeof documentId !== "string" || typeof expectedHash !== "string") {
          return diagnostic(
            "transaction.precondition.payload-invalid",
            "document-hash requires string documentId and expectedHash"
          );
        }
        const actualHash = context.documentHash(documentId);
        return actualHash === expectedHash
          ? undefined
          : diagnostic(
              "transaction.precondition.document-hash-failed",
              `Document ${documentId} hash is ${actualHash ?? "missing"}, expected ${expectedHash}`,
              undefined,
              documentId
            );
      }
    );
  }

  registerOperationHandler(handler: OperationHandler): () => void {
    const key = handlerKey(handler.operationType, handler.schemaVersion);
    if (this.#operationHandlers.has(key)) {
      throw new Error(`Operation handler ${key} is already registered`);
    }
    this.#operationHandlers.set(key, handler);
    return () => this.#operationHandlers.delete(key);
  }

  registerDocumentValidator(validator: DocumentValidator): () => void {
    const key = handlerKey(validator.documentType, validator.schemaVersion);
    if (this.#documentValidators.has(key)) {
      throw new Error(`Document validator ${key} is already registered`);
    }
    this.#documentValidators.set(key, validator);
    return () => this.#documentValidators.delete(key);
  }

  registerCrossDocumentValidator(
    validator: CrossDocumentValidator
  ): () => void {
    this.#crossDocumentValidators.push(validator);
    return () => {
      const index = this.#crossDocumentValidators.indexOf(validator);
      if (index !== -1) this.#crossDocumentValidators.splice(index, 1);
    };
  }

  registerPrecondition(
    type: string,
    evaluator: PreconditionEvaluator
  ): () => void {
    if (this.#preconditionEvaluators.has(type)) {
      throw new Error(`Precondition evaluator ${type} is already registered`);
    }
    this.#preconditionEvaluators.set(type, evaluator);
    return () => this.#preconditionEvaluators.delete(type);
  }

  async validateState(state: DocumentState): Promise<readonly Diagnostic[]> {
    const documents = structuredClone(state) as Record<string, JsonValue>;
    return this.#validateDocuments(
      documents,
      new Set(Object.keys(documents)),
      new Set<string>()
    );
  }

  async execute(
    proposal: TransactionProposal
  ): Promise<TransactionExecutionResult> {
    const proposalDiagnostics = validateProposal(proposal);
    if (hasErrorDiagnostics(proposalDiagnostics)) {
      throw new TransactionRejectedError(
        `Transaction ${proposal.transactionId} is invalid`,
        proposalDiagnostics
      );
    }
    if (this.history.findCommitByTransactionId(proposal.transactionId)) {
      throw new TransactionRejectedError(
        `Transaction ${proposal.transactionId} was already committed`,
        [
          diagnostic(
            "transaction.id-duplicate",
            `Transaction ${proposal.transactionId} was already committed`
          )
        ]
      );
    }

    const parentCommitId = this.history.getBranchHead(proposal.branchName);
    const beforeState = this.history.stateAt(parentCommitId);
    const draft = structuredClone(beforeState) as Record<string, JsonValue>;
    const readSet = new Set<string>();
    const changedDocumentIds = new Set<string>();
    const diagnostics: Diagnostic[] = [];

    for (const [operationIndex, operation] of proposal.operations.entries()) {
      const context = new DraftReadContext(draft, readSet);
      const preconditionDiagnostics = await this.#evaluatePreconditions(
        operation,
        context
      );
      if (hasErrorDiagnostics(preconditionDiagnostics)) {
        throw new TransactionRejectedError(
          `Preconditions failed for ${operation.operationId}`,
          preconditionDiagnostics
        );
      }
      diagnostics.push(...preconditionDiagnostics);

      const handler = this.#operationHandlers.get(
        handlerKey(operation.operationType, operation.schemaVersion)
      );
      if (handler === undefined) {
        throw new TransactionRejectedError(
          `No handler for ${operation.operationType}@${operation.schemaVersion}`,
          [
            diagnostic(
              "transaction.operation.handler-missing",
              `No handler registered for ${operation.operationType}@${operation.schemaVersion}`,
              `/operations/${operationIndex}`
            )
          ]
        );
      }

      let effect: OperationEffect;
      try {
        effect = await handler.prepare(operation, context);
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        throw new TransactionRejectedError(
          `Operation ${operation.operationId} failed: ${cause}`,
          [
            diagnostic(
              "transaction.operation.prepare-failed",
              cause,
              `/operations/${operationIndex}`
            )
          ]
        );
      }

      const effectDiagnostics = effect.diagnostics ?? [];
      if (hasErrorDiagnostics(effectDiagnostics)) {
        throw new TransactionRejectedError(
          `Operation ${operation.operationId} was rejected`,
          effectDiagnostics
        );
      }
      diagnostics.push(...effectDiagnostics);
      this.#applyMutations(
        effect.mutations ?? [],
        draft,
        changedDocumentIds,
        operationIndex
      );
    }

    if (changedDocumentIds.size === 0) {
      throw new TransactionRejectedError(
        `Transaction ${proposal.transactionId} made no changes`,
        [
          diagnostic(
            "transaction.no-changes",
            "A committed transaction must change at least one document"
          )
        ]
      );
    }

    diagnostics.push(
      ...(await this.#validateDocuments(draft, changedDocumentIds, readSet))
    );
    if (hasErrorDiagnostics(diagnostics)) {
      throw new TransactionRejectedError(
        `Transaction ${proposal.transactionId} failed validation`,
        diagnostics
      );
    }

    const patches = [...changedDocumentIds]
      .sort()
      .map((documentId) =>
        createDocumentPatch(
          documentId,
          beforeState[documentId] ?? null,
          draft[documentId] ?? null
        )
      )
      .filter(
        (patch) =>
          patch.beforeHash !== patch.afterHash ||
          patch.beforeHash === null ||
          patch.afterHash === null
      );

    if (patches.length === 0) {
      throw new TransactionRejectedError(
        `Transaction ${proposal.transactionId} normalized to no changes`,
        [
          diagnostic(
            "transaction.no-semantic-changes",
            "Document mutations produced no semantic changes"
          )
        ]
      );
    }

    const commit: HistoryCommit = {
      commitId: this.#host.createCommitId(),
      parentCommitIds: [parentCommitId],
      transaction: structuredClone(proposal),
      committedAt: this.#host.now().toISOString(),
      patches,
      diagnostics,
      metadata: {
        ...(proposal.metadata ?? {}),
        readDocumentIds: [...readSet].sort(),
        changedDocumentIds: [...changedDocumentIds].sort()
      }
    };
    this.history.appendCommit(proposal.branchName, commit);
    return { commit: structuredClone(commit), proposal: structuredClone(proposal) };
  }

  async #validateDocuments(
    documents: Record<string, JsonValue>,
    documentIds: ReadonlySet<string>,
    readSet: Set<string>
  ): Promise<readonly Diagnostic[]> {
    const diagnostics: Diagnostic[] = [];
    const validationContext = new DraftReadContext(documents, readSet);
    for (const documentId of [...documentIds].sort()) {
      const document = asDocument(documents[documentId]);
      if (document === undefined) continue;
      const schemaDiagnostics = validateDocumentEnvelopeSchema(document).map(
        (item) => ({ ...item, documentId })
      );
      diagnostics.push(...schemaDiagnostics);
      if (hasErrorDiagnostics(schemaDiagnostics)) continue;

      const validator = this.#documentValidators.get(
        handlerKey(document.documentType, document.schemaVersion)
      );
      if (validator === undefined) {
        diagnostics.push(
          diagnostic(
            "transaction.document.validator-missing",
            `No validator registered for ${document.documentType}@${document.schemaVersion}`,
            undefined,
            documentId
          )
        );
        continue;
      }
      diagnostics.push(...(await validator.validate(document, validationContext)));
    }

    for (const validator of this.#crossDocumentValidators) {
      diagnostics.push(...(await validator(validationContext, documentIds)));
    }
    return diagnostics;
  }

  async #evaluatePreconditions(
    operation: Operation,
    context: OperationReadContext
  ): Promise<readonly Diagnostic[]> {
    const diagnostics: Diagnostic[] = [];
    for (const precondition of operation.preconditions ?? []) {
      const evaluator = this.#preconditionEvaluators.get(precondition.type);
      if (evaluator === undefined) {
        diagnostics.push(
          diagnostic(
            "transaction.precondition.evaluator-missing",
            `No evaluator for ${precondition.type}@${precondition.schemaVersion}`
          )
        );
        continue;
      }
      const result = await evaluator(precondition, context);
      if (result !== undefined) diagnostics.push(result);
    }
    return diagnostics;
  }

  #applyMutations(
    mutations: readonly DocumentMutation[],
    draft: Record<string, JsonValue>,
    changedDocumentIds: Set<string>,
    operationIndex: number
  ): void {
    const seen = new Set<string>();
    for (const [mutationIndex, mutation] of mutations.entries()) {
      if (seen.has(mutation.documentId)) {
        throw new TransactionRejectedError(
          "Operation returned duplicate document mutations",
          [
            diagnostic(
              "transaction.mutation.document-duplicate",
              `Duplicate mutation for ${mutation.documentId}`,
              `/operations/${operationIndex}/mutations/${mutationIndex}`,
              mutation.documentId
            )
          ]
        );
      }
      seen.add(mutation.documentId);
      const exists = draft[mutation.documentId] !== undefined;

      if (mutation.kind === "create") {
        if (exists) {
          throw new TransactionRejectedError("Create mutation target exists", [
            diagnostic(
              "transaction.mutation.create-exists",
              `Document ${mutation.documentId} already exists`,
              undefined,
              mutation.documentId
            )
          ]);
        }
        if (mutation.document.documentId !== mutation.documentId) {
          throw new TransactionRejectedError("Create mutation id mismatch", [
            diagnostic(
              "transaction.mutation.id-mismatch",
              `Mutation id ${mutation.documentId} does not match envelope id ${mutation.document.documentId}`,
              undefined,
              mutation.documentId
            )
          ]);
        }
        draft[mutation.documentId] = cloneJson(
          mutation.document as unknown as JsonValue
        );
      } else if (mutation.kind === "replace") {
        if (!exists) {
          throw new TransactionRejectedError("Replace mutation target missing", [
            diagnostic(
              "transaction.mutation.replace-missing",
              `Document ${mutation.documentId} does not exist`,
              undefined,
              mutation.documentId
            )
          ]);
        }
        if (mutation.document.documentId !== mutation.documentId) {
          throw new TransactionRejectedError("Replace mutation id mismatch", [
            diagnostic(
              "transaction.mutation.id-mismatch",
              `Mutation id ${mutation.documentId} does not match envelope id ${mutation.document.documentId}`,
              undefined,
              mutation.documentId
            )
          ]);
        }
        draft[mutation.documentId] = cloneJson(
          mutation.document as unknown as JsonValue
        );
      } else {
        if (!exists) {
          throw new TransactionRejectedError("Delete mutation target missing", [
            diagnostic(
              "transaction.mutation.delete-missing",
              `Document ${mutation.documentId} does not exist`,
              undefined,
              mutation.documentId
            )
          ]);
        }
        delete draft[mutation.documentId];
      }
      changedDocumentIds.add(mutation.documentId);
    }
  }
}
