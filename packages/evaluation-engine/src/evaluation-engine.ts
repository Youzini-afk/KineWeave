import { validateDocumentEnvelopeSchema } from "@kineweave/project-format";
import {
  assertJsonValue,
  assertQualifiedName,
  assertStableId,
  cloneJson,
  compareRational,
  type Diagnostic,
  type EvaluationRequest,
  hasErrorDiagnostics,
  type JsonObject,
  type JsonValue,
  type ProjectDocumentEnvelope,
  parseRational,
  type ResolvedPresentationGraph,
  rational,
  timeValue
} from "@kineweave/protocol";
import { validatePresentationGraph } from "./presentation-validation.js";
import type {
  DocumentEvaluator,
  EvaluationContributionRegistry,
  EvaluationDocumentState,
  EvaluationEngineOptions,
  EvaluationExecutionResult,
  EvaluationReadContext
} from "./types.js";

function evaluatorKey(documentType: string, schemaVersion: number): string {
  return `${documentType}@${schemaVersion}`;
}

function error(code: string, message: string, jsonPointer?: string): Diagnostic {
  return {
    severity: "error",
    code,
    message,
    ...(jsonPointer === undefined ? {} : { jsonPointer }),
    source: "@kineweave/evaluation-engine"
  };
}

function cloneState(state: EvaluationDocumentState): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(state).map(([documentId, document]) => [documentId, cloneJson(document)])
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isDiagnostic(value: unknown): value is Diagnostic {
  if (!isPlainObject(value)) return false;
  if (value.severity !== "info" && value.severity !== "warning" && value.severity !== "error") {
    return false;
  }
  if (typeof value.code !== "string" || typeof value.message !== "string") {
    return false;
  }
  for (const key of ["resourceUri", "jsonPointer", "documentId", "source"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") return false;
  }
  if (value.details !== undefined) {
    if (!isPlainObject(value.details)) return false;
    try {
      assertJsonValue(value.details, "diagnostic details");
    } catch {
      return false;
    }
  }
  return true;
}

function normalizeRequest(request: EvaluationRequest): EvaluationRequest {
  assertStableId(request.documentId, "evaluation document id");
  if (
    !Number.isSafeInteger(request.viewport.width) ||
    request.viewport.width <= 0 ||
    !Number.isSafeInteger(request.viewport.height) ||
    request.viewport.height <= 0
  ) {
    throw new TypeError("Evaluation viewport dimensions must be positive integers");
  }
  const pixelRatio = parseRational(request.viewport.pixelRatio);
  if (compareRational(pixelRatio, rational(0)) <= 0) {
    throw new RangeError("Evaluation pixel ratio must be positive");
  }
  const time = timeValue(parseRational(request.time.value), request.time.domain);
  assertQualifiedName(request.colorSpace, "evaluation color space");
  if (request.locale.length === 0) throw new TypeError("Evaluation locale is required");
  if (request.randomSeed.length === 0) {
    throw new TypeError("Evaluation random seed is required");
  }
  for (const [signalId, value] of Object.entries(request.externalSignals)) {
    assertStableId(signalId, "external signal id");
    assertJsonValue(value, `external signal ${signalId}`);
  }
  return {
    ...request,
    time,
    viewport: { ...request.viewport, pixelRatio },
    externalSignals: Object.fromEntries(
      Object.entries(request.externalSignals).map(([signalId, value]) => [
        signalId,
        cloneJson(value)
      ])
    )
  };
}

class ReadContext implements EvaluationReadContext {
  constructor(
    readonly request: EvaluationRequest,
    readonly documents: Record<string, JsonValue>
  ) {}

  readDocument<TData extends JsonObject = JsonObject>(
    documentId: string
  ): ProjectDocumentEnvelope<TData> | undefined {
    const document = this.documents[documentId];
    return document === undefined
      ? undefined
      : (cloneJson(document) as unknown as ProjectDocumentEnvelope<TData>);
  }

  listDocumentIds(): readonly string[] {
    return Object.keys(this.documents).sort();
  }
}

export class EvaluationRejectedError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(message: string, diagnostics: readonly Diagnostic[]) {
    super(message);
    this.name = "EvaluationRejectedError";
    this.diagnostics = diagnostics;
  }
}

export class EvaluationEngine implements EvaluationContributionRegistry {
  readonly #options: EvaluationEngineOptions;
  readonly #evaluators = new Map<string, DocumentEvaluator>();

  constructor(options: EvaluationEngineOptions) {
    this.#options = options;
  }

  registerDocumentEvaluator(evaluator: DocumentEvaluator): () => void {
    assertQualifiedName(evaluator.documentType, "evaluator document type");
    if (!Number.isSafeInteger(evaluator.schemaVersion) || evaluator.schemaVersion <= 0) {
      throw new TypeError("Evaluator schemaVersion must be a positive integer");
    }
    if (
      evaluator.presentationGraphVersions.length === 0 ||
      evaluator.presentationGraphVersions.some(
        (version) => !Number.isSafeInteger(version) || version <= 0
      ) ||
      new Set(evaluator.presentationGraphVersions).size !==
        evaluator.presentationGraphVersions.length
    ) {
      throw new TypeError(
        "Evaluator presentationGraphVersions must contain unique positive integers"
      );
    }
    const key = evaluatorKey(evaluator.documentType, evaluator.schemaVersion);
    if (this.#evaluators.has(key)) {
      throw new Error(`Document evaluator ${key} is already registered`);
    }
    this.#evaluators.set(key, evaluator);
    return () => this.#evaluators.delete(key);
  }

  async evaluate(request: EvaluationRequest): Promise<EvaluationExecutionResult> {
    let normalized: EvaluationRequest;
    try {
      normalized = normalizeRequest(request);
    } catch (caught) {
      throw new EvaluationRejectedError("Evaluation request is invalid", [
        error(
          "evaluation.request.invalid",
          caught instanceof Error ? caught.message : String(caught)
        )
      ]);
    }

    let documents: Record<string, JsonValue>;
    try {
      documents = cloneState(this.#options.host.resolveState(normalized.state));
    } catch (caught) {
      throw new EvaluationRejectedError("Evaluation state cannot be resolved", [
        error(
          "evaluation.state.unavailable",
          caught instanceof Error ? caught.message : String(caught)
        )
      ]);
    }
    const rawDocument = documents[normalized.documentId];
    if (rawDocument === undefined) {
      throw new EvaluationRejectedError("Evaluation document is missing", [
        error("evaluation.document.missing", `Document ${normalized.documentId} does not exist`)
      ]);
    }
    const envelopeDiagnostics = validateDocumentEnvelopeSchema(rawDocument).map((item) => ({
      ...item,
      documentId: normalized.documentId
    }));
    if (hasErrorDiagnostics(envelopeDiagnostics)) {
      throw new EvaluationRejectedError(
        "Evaluation document envelope is invalid",
        envelopeDiagnostics
      );
    }
    const document = rawDocument as unknown as ProjectDocumentEnvelope<JsonObject>;
    const evaluator = this.#evaluators.get(
      evaluatorKey(document.documentType, document.schemaVersion)
    );
    if (evaluator === undefined) {
      throw new EvaluationRejectedError("Document evaluator is unavailable", [
        error(
          "evaluation.evaluator.missing",
          `No evaluator registered for ${document.documentType}@${document.schemaVersion}`
        )
      ]);
    }

    let output: unknown;
    try {
      output = await evaluator.evaluate(
        document,
        normalized,
        new ReadContext(normalized, documents)
      );
    } catch (caught) {
      throw new EvaluationRejectedError("Document evaluation failed", [
        error(
          "evaluation.evaluator.failed",
          caught instanceof Error ? caught.message : String(caught)
        )
      ]);
    }
    if (!isPlainObject(output) || !("graph" in output)) {
      throw new EvaluationRejectedError("Document evaluator returned invalid output", [
        error(
          "evaluation.evaluator.output-invalid",
          "Evaluator output must be an object containing graph"
        )
      ]);
    }
    let evaluatorDiagnostics: readonly Diagnostic[] = [];
    if (output.diagnostics !== undefined) {
      if (!Array.isArray(output.diagnostics) || !output.diagnostics.every(isDiagnostic)) {
        throw new EvaluationRejectedError("Document evaluator returned invalid diagnostics", [
          error(
            "evaluation.evaluator.diagnostics-invalid",
            "Evaluator diagnostics must contain valid Diagnostic objects"
          )
        ]);
      }
      evaluatorDiagnostics = output.diagnostics;
    }
    const graphDiagnostics = validatePresentationGraph(output.graph);
    const diagnostics: Diagnostic[] = [...evaluatorDiagnostics, ...graphDiagnostics];
    if (hasErrorDiagnostics(graphDiagnostics)) {
      throw new EvaluationRejectedError("Evaluation output is invalid", diagnostics);
    }
    const graph = output.graph as ResolvedPresentationGraph;
    if (!evaluator.presentationGraphVersions.includes(graph.presentationGraphVersion)) {
      diagnostics.push(
        error(
          "evaluation.graph.version-unsupported",
          `Evaluator returned Presentation Graph v${graph.presentationGraphVersion}, but declares ${evaluator.presentationGraphVersions.join(", ")}`
        )
      );
    }
    if (graph.documentId !== normalized.documentId) {
      diagnostics.push(
        error(
          "evaluation.graph.document-mismatch",
          `Evaluator returned graph for ${graph.documentId}, expected ${normalized.documentId}`
        )
      );
    }
    if (
      graph.time.domain !== normalized.time.domain ||
      compareRational(graph.time.value, normalized.time.value) !== 0
    ) {
      diagnostics.push(
        error("evaluation.graph.time-mismatch", "Evaluator returned a graph for a different time")
      );
    }
    if (
      graph.viewport.width !== normalized.viewport.width ||
      graph.viewport.height !== normalized.viewport.height ||
      compareRational(graph.viewport.pixelRatio, normalized.viewport.pixelRatio) !== 0
    ) {
      diagnostics.push(
        error(
          "evaluation.graph.viewport-mismatch",
          "Evaluator returned a graph for a different viewport"
        )
      );
    }
    if (graph.colorSpace !== normalized.colorSpace) {
      diagnostics.push(
        error(
          "evaluation.graph.color-space-mismatch",
          `Evaluator returned ${graph.colorSpace}, expected ${normalized.colorSpace}`
        )
      );
    }
    if (hasErrorDiagnostics(diagnostics)) {
      throw new EvaluationRejectedError("Evaluation output is invalid", diagnostics);
    }
    return {
      graph: structuredClone(graph),
      diagnostics: structuredClone(diagnostics)
    };
  }
}
