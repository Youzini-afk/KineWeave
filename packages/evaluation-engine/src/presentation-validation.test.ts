import { describe, expect, it } from "vitest";
import {
  PRESENTATION_GRAPH_VERSION,
  STANDARD_COLOR_SPACES,
  STANDARD_PRESENTATION_PRIMITIVES,
  STANDARD_TIME_DOMAINS,
  rational,
  timeValue,
  type ResolvedPresentationGraph
} from "@kineweave/protocol";
import { validatePresentationGraph } from "./presentation-validation.js";

function graph(): ResolvedPresentationGraph {
  return {
    presentationGraphVersion: PRESENTATION_GRAPH_VERSION,
    documentId: "document_main",
    time: timeValue(rational(0), STANDARD_TIME_DOMAINS.seconds),
    viewport: { width: 1920, height: 1080, pixelRatio: rational(1) },
    colorSpace: STANDARD_COLOR_SPACES.srgb,
    background: null,
    rootNodeIds: ["node_root"],
    nodes: {
      node_root: {
        presentationId: "node_root",
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
        data: {}
      }
    },
    requiredFeatures: [
      STANDARD_PRESENTATION_PRIMITIVES.group,
      STANDARD_COLOR_SPACES.srgb
    ]
  };
}

describe("validatePresentationGraph", () => {
  it("rejects a primitive omitted from requiredFeatures", () => {
    const invalid = {
      ...graph(),
      requiredFeatures: [STANDARD_COLOR_SPACES.srgb]
    };

    expect(validatePresentationGraph(invalid)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "presentation.feature.primitive-missing" })
      ])
    );
  });

  it("rejects duplicate roots and duplicate child edges", () => {
    const valid = graph();
    const invalid = {
      ...valid,
      rootNodeIds: ["node_root", "node_root"],
      nodes: {
        node_root: {
          ...valid.nodes.node_root!,
          children: ["node_child", "node_child"]
        },
        node_child: {
          ...valid.nodes.node_root!,
          presentationId: "node_child",
          children: []
        }
      }
    };

    const diagnostics = validatePresentationGraph(invalid);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "presentation.hierarchy.root-duplicate" }),
        expect.objectContaining({ code: "presentation.hierarchy.child-duplicate" })
      ])
    );
  });

  it("requires node data to be a JSON object", () => {
    const invalid = graph() as unknown as {
      nodes: Record<string, { data: unknown }>;
    };
    invalid.nodes.node_root!.data = null;

    expect(validatePresentationGraph(invalid)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "presentation.node.data-invalid" })
      ])
    );
  });

  it("validates the standard text primitive contract before rendering", () => {
    const valid = graph();
    const invalid = {
      ...valid,
      nodes: {
        node_root: {
          ...valid.nodes.node_root!,
          primitive: STANDARD_PRESENTATION_PRIMITIVES.text,
          children: ["node_child"],
          data: { text: 42, fontSize: 0 }
        },
        node_child: {
          ...valid.nodes.node_root!,
          presentationId: "node_child"
        }
      },
      requiredFeatures: [
        STANDARD_PRESENTATION_PRIMITIVES.text,
        STANDARD_PRESENTATION_PRIMITIVES.group,
        STANDARD_COLOR_SPACES.srgb
      ]
    };

    expect(validatePresentationGraph(invalid)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "presentation.node.children-unsupported" }),
        expect.objectContaining({ code: "presentation.text.text-invalid" }),
        expect.objectContaining({ code: "presentation.text.font-size-invalid" })
      ])
    );
  });

  it("requires custom packet types to participate in feature negotiation", () => {
    const valid = graph();
    const packetType = "org.example.presentation/particles";
    const invalid = {
      ...valid,
      nodes: {
        node_root: {
          ...valid.nodes.node_root!,
          primitive: STANDARD_PRESENTATION_PRIMITIVES.custom,
          data: {
            packetType,
            schemaVersion: 1,
            nodeData: {},
            properties: {}
          }
        }
      },
      requiredFeatures: [
        STANDARD_PRESENTATION_PRIMITIVES.custom,
        STANDARD_COLOR_SPACES.srgb
      ]
    };

    expect(validatePresentationGraph(invalid)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "presentation.feature.semantic-missing" })
      ])
    );
  });

  it("turns malformed extension output into diagnostics instead of throwing", () => {
    expect(() =>
      validatePresentationGraph({
        presentationGraphVersion: PRESENTATION_GRAPH_VERSION,
        documentId: "document_main",
        viewport: null,
        time: null,
        colorSpace: null,
        background: null,
        rootNodeIds: [],
        nodes: { node_root: { transform: null, data: [] } },
        requiredFeatures: []
      })
    ).not.toThrow();
  });
});
