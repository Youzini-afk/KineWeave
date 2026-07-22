import { describe, expect, it } from "vitest";
import { EvaluationEngine } from "@kineweave/evaluation-engine";
import {
  STANDARD_PRESENTATION_PRIMITIVES,
  STANDARD_COLOR_SPACES,
  STANDARD_TIME_DOMAINS,
  rational,
  timeValue,
  type EvaluationRequest,
  type JsonObject,
  type JsonValue
} from "@kineweave/protocol";
import { standardMotionDocumentEvaluator } from "./evaluator.js";
import {
  STANDARD_VALUE_TYPES,
  createExternalSignal,
  createStandardComposition,
  serializedTime,
  type StandardCompositionDocument
} from "./model.js";

function request(
  numerator: number,
  denominator = 1,
  externalSignals: Readonly<Record<string, JsonValue>> = {}
): EvaluationRequest {
  return {
    documentId: "document_main",
    time: timeValue(
      rational(numerator, denominator),
      STANDARD_TIME_DOMAINS.seconds
    ),
    mode: "deterministic",
    viewport: { width: 1920, height: 1080, pixelRatio: rational(1) },
    colorSpace: STANDARD_COLOR_SPACES.srgb,
    locale: "en-US",
    randomSeed: "standard-motion-test",
    externalSignals
  };
}

function engine(document: StandardCompositionDocument): EvaluationEngine {
  const evaluation = new EvaluationEngine({
    host: {
      resolveState: () => ({
        [document.documentId]: document as unknown as JsonObject
      })
    }
  });
  evaluation.registerDocumentEvaluator(standardMotionDocumentEvaluator);
  return evaluation;
}

describe("Standard Motion evaluator", () => {
  it("resolves a composition into renderer-independent text primitives", async () => {
    const evaluation = engine(createStandardComposition());
    const result = await evaluation.evaluate(request(1));

    expect(result.graph.nodes.node_headline).toMatchObject({
      primitive: STANDARD_PRESENTATION_PRIMITIVES.text,
      transform: { translation: [960, 540] },
      data: {
        text: "Hello KineWeave",
        fontSize: 96,
        fill: "#ffffff"
      }
    });
  });

  it("samples exact-time tracks with linear vector interpolation", async () => {
    const document = createStandardComposition();
    document.data.tracks.track_position = {
      trackId: "track_position",
      valueType: STANDARD_VALUE_TYPES.vector2,
      target: { nodeId: "node_headline", property: "position" },
      keyframes: {
        keyframe_start: {
          keyframeId: "keyframe_start",
          time: serializedTime(
            timeValue(rational(0), STANDARD_TIME_DOMAINS.seconds)
          ),
          value: [0, 0]
        },
        keyframe_end: {
          keyframeId: "keyframe_end",
          time: serializedTime(
            timeValue(rational(1), STANDARD_TIME_DOMAINS.seconds)
          ),
          value: [100, 50]
        }
      }
    };
    document.data.nodes.node_headline!.properties.position = {
      kind: "track",
      trackId: "track_position"
    };

    const result = await engine(document).evaluate(request(1, 2));
    expect(result.graph.nodes.node_headline?.transform.translation).toEqual([
      50, 25
    ]);
  });

  it("resolves explicit external signal snapshots deterministically", async () => {
    const document = createStandardComposition();
    document.data.signals.signal_headline = createExternalSignal(
      "signal_headline",
      "headline_input",
      STANDARD_VALUE_TYPES.string
    );
    document.data.nodes.node_headline!.properties.content = {
      kind: "signal",
      signalId: "signal_headline"
    };

    const result = await engine(document).evaluate(
      request(0, 1, { headline_input: "Signal-driven headline" })
    );
    expect(result.graph.nodes.node_headline?.data.text).toBe(
      "Signal-driven headline"
    );
  });

  it("rejects an external signal value that violates its declared value type", async () => {
    const document = createStandardComposition();
    document.data.signals.signal_headline = createExternalSignal(
      "signal_headline",
      "headline_input",
      STANDARD_VALUE_TYPES.string
    );
    document.data.nodes.node_headline!.properties.content = {
      kind: "signal",
      signalId: "signal_headline"
    };

    await expect(
      engine(document).evaluate(request(0, 1, { headline_input: 42 }))
    ).rejects.toMatchObject({
      diagnostics: [
        expect.objectContaining({
          code: "standard-motion.evaluation.external-signal-value-invalid"
        })
      ]
    });
  });

  it("rejects a cyclic raw document without recursing indefinitely", async () => {
    const document = createStandardComposition();
    document.data.nodes.node_headline = {
      ...document.data.nodes.node_headline!,
      children: ["node_headline"]
    };

    await expect(engine(document).evaluate(request(0))).rejects.toMatchObject({
      diagnostics: expect.arrayContaining([
        expect.objectContaining({ code: "standard-motion.hierarchy.cycle" })
      ])
    });
  });
});
