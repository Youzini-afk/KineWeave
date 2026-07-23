import {
  type EvaluationRequest,
  type JsonObject,
  PRESENTATION_GRAPH_VERSION,
  type ResolvedPresentationGraph,
  rational,
  STANDARD_COLOR_SPACES,
  STANDARD_PRESENTATION_PRIMITIVES,
  STANDARD_TIME_DOMAINS,
  timeValue
} from "@kineweave/protocol";
import { describe, expect, it } from "vitest";
import { EvaluationEngine, EvaluationRejectedError } from "./evaluation-engine.js";

const DOCUMENT_TYPE = "org.example.motion/composition";

function request(): EvaluationRequest {
  return {
    documentId: "document_main",
    state: { kind: "branch", branchName: "proposal/test" },
    time: timeValue(rational(1, 2), STANDARD_TIME_DOMAINS.seconds),
    mode: "deterministic",
    viewport: { width: 1920, height: 1080, pixelRatio: rational(1) },
    colorSpace: STANDARD_COLOR_SPACES.srgb,
    locale: "zh-CN",
    randomSeed: "test-seed",
    externalSignals: {}
  };
}

function graph(value = "hello"): ResolvedPresentationGraph {
  const evaluationRequest = request();
  return {
    presentationGraphVersion: PRESENTATION_GRAPH_VERSION,
    documentId: evaluationRequest.documentId,
    time: evaluationRequest.time,
    viewport: evaluationRequest.viewport,
    colorSpace: evaluationRequest.colorSpace,
    background: null,
    rootNodeIds: ["presentation_root"],
    nodes: {
      presentation_root: {
        presentationId: "presentation_root",
        primitive: STANDARD_PRESENTATION_PRIMITIVES.group,
        children: [],
        visible: true,
        opacity: 1,
        transform: {
          translation: [0, 0],
          scale: [1, 1],
          rotation: 0,
          anchor: [0, 0]
        },
        data: { value }
      }
    },
    requiredFeatures: [STANDARD_PRESENTATION_PRIMITIVES.group, STANDARD_COLOR_SPACES.srgb]
  };
}

function documentState(): Readonly<Record<string, JsonObject>> {
  return {
    document_main: {
      documentId: "document_main",
      documentType: DOCUMENT_TYPE,
      schemaVersion: 1,
      data: { value: "hello" }
    }
  };
}

describe("EvaluationEngine", () => {
  it("resolves the requested state and evaluates through a registered provider", async () => {
    let resolvedBranch = "";
    const engine = new EvaluationEngine({
      host: {
        resolveState(reference) {
          resolvedBranch = reference?.kind === "branch" ? reference.branchName : "";
          return documentState();
        }
      }
    });
    engine.registerDocumentEvaluator({
      documentType: DOCUMENT_TYPE,
      schemaVersion: 1,
      presentationGraphVersions: [PRESENTATION_GRAPH_VERSION],
      evaluate(document) {
        return { graph: graph(document.data.value as string) };
      }
    });

    const result = await engine.evaluate(request());
    expect(resolvedBranch).toBe("proposal/test");
    expect(result.graph.nodes.presentation_root?.data.value).toBe("hello");
    expect(result.diagnostics).toEqual([]);
  });

  it("rejects a document type with no evaluator", async () => {
    const engine = new EvaluationEngine({
      host: { resolveState: documentState }
    });

    await expect(engine.evaluate(request())).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: "evaluation.evaluator.missing" })]
    });
  });

  it("rejects an invalid presentation hierarchy", async () => {
    const engine = new EvaluationEngine({
      host: { resolveState: documentState }
    });
    engine.registerDocumentEvaluator({
      documentType: DOCUMENT_TYPE,
      schemaVersion: 1,
      presentationGraphVersions: [PRESENTATION_GRAPH_VERSION],
      evaluate() {
        const invalid = graph();
        return {
          graph: {
            ...invalid,
            rootNodeIds: []
          }
        };
      }
    });

    await expect(engine.evaluate(request())).rejects.toBeInstanceOf(EvaluationRejectedError);
  });

  it("wraps malformed evaluator output as a rejected evaluation", async () => {
    const engine = new EvaluationEngine({
      host: { resolveState: documentState }
    });
    engine.registerDocumentEvaluator({
      documentType: DOCUMENT_TYPE,
      schemaVersion: 1,
      presentationGraphVersions: [PRESENTATION_GRAPH_VERSION],
      evaluate() {
        return { graph: null } as never;
      }
    });

    await expect(engine.evaluate(request())).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: "presentation.graph.invalid" })]
    });
  });
});
