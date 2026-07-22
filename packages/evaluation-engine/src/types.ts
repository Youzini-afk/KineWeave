import type {
  Diagnostic,
  EvaluationRequest,
  EvaluationStateReference,
  JsonObject,
  JsonValue,
  ProjectDocumentEnvelope,
  ResolvedPresentationGraph
} from "@kineweave/protocol";

export type EvaluationDocumentState = Readonly<Record<string, JsonValue>>;

export interface EvaluationReadContext {
  readonly request: EvaluationRequest;
  readDocument<TData extends JsonObject = JsonObject>(
    documentId: string
  ): ProjectDocumentEnvelope<TData> | undefined;
  listDocumentIds(): readonly string[];
}

export interface DocumentEvaluationOutput {
  readonly graph: ResolvedPresentationGraph;
  readonly diagnostics?: readonly Diagnostic[];
}

export interface DocumentEvaluator {
  readonly documentType: string;
  readonly schemaVersion: number;
  evaluate(
    document: ProjectDocumentEnvelope<JsonObject>,
    request: EvaluationRequest,
    context: EvaluationReadContext
  ): DocumentEvaluationOutput | Promise<DocumentEvaluationOutput>;
}

export interface EvaluationContributionRegistry {
  registerDocumentEvaluator(evaluator: DocumentEvaluator): () => void;
}

export interface EvaluationEngineHost {
  readonly resolveState: (
    reference: EvaluationStateReference | undefined
  ) => EvaluationDocumentState;
}

export interface EvaluationEngineOptions {
  readonly host: EvaluationEngineHost;
}

export interface EvaluationExecutionResult {
  readonly graph: ResolvedPresentationGraph;
  readonly diagnostics: readonly Diagnostic[];
}
