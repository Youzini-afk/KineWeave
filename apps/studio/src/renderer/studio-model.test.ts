import {
  PRESENTATION_GRAPH_VERSION,
  type ResolvedPresentationGraph,
  rational,
  STANDARD_COLOR_SPACES,
  STANDARD_PRESENTATION_PRIMITIVES,
  STANDARD_TIME_DOMAINS,
  timeValue
} from "@kineweave/protocol";
import {
  createStandardComposition,
  type StandardCompositionDocument
} from "@kineweave/standard-motion-document";
import { describe, expect, it } from "vitest";
import {
  compositionDurationSeconds,
  findLayerParent,
  flattenLayerTree,
  inspectorFields,
  roundCompositionCoordinate,
  selectionPolygon
} from "./studio-model.js";

describe("Studio model", () => {
  it("flattens the composition hierarchy without losing parent and order", () => {
    const document = createStandardComposition();
    const layers = flattenLayerTree(document);

    expect(layers.map((item) => [item.node.nodeId, item.depth])).toEqual([
      ["node_scene", 0],
      ["node_panel", 1],
      ["node_orbit", 1],
      ["node_mark", 1],
      ["node_headline", 1]
    ]);
    expect(findLayerParent(document, "node_headline")).toEqual({
      parentNodeId: "node_scene",
      index: 3
    });
    expect(compositionDurationSeconds(document)).toBe(5);
  });

  it("describes only properties relevant to the selected node type", () => {
    const document = createStandardComposition();
    const panel = document.data.nodes.node_panel!;
    const properties = inspectorFields(panel).map((item) => item.property);

    expect(properties).toEqual(
      expect.arrayContaining([
        "position",
        "rotation",
        "opacity",
        "visible",
        "size",
        "cornerRadius",
        "fill",
        "stroke",
        "strokeWidth"
      ])
    );
    expect(properties).not.toContain("content");
  });

  it("maps nested transformed geometry into fitted Stage coordinates", () => {
    const graph: ResolvedPresentationGraph = {
      presentationGraphVersion: PRESENTATION_GRAPH_VERSION,
      documentId: "document_main",
      time: timeValue(rational(0), STANDARD_TIME_DOMAINS.seconds),
      viewport: { width: 400, height: 200, pixelRatio: rational(1) },
      colorSpace: STANDARD_COLOR_SPACES.srgb,
      background: null,
      rootNodeIds: ["node_group"],
      nodes: {
        node_group: {
          presentationId: "node_group",
          primitive: STANDARD_PRESENTATION_PRIMITIVES.group,
          children: ["node_rectangle"],
          visible: true,
          opacity: 1,
          transform: {
            translation: [50, 25],
            scale: [1, 1],
            rotation: 0,
            anchor: [0, 0]
          },
          data: {}
        },
        node_rectangle: {
          presentationId: "node_rectangle",
          primitive: STANDARD_PRESENTATION_PRIMITIVES.rectangle,
          children: [],
          visible: true,
          opacity: 1,
          transform: {
            translation: [50, 25],
            scale: [1, 1],
            rotation: 0,
            anchor: [0, 0]
          },
          data: { width: 40, height: 20, cornerRadius: 0 }
        }
      },
      requiredFeatures: [
        STANDARD_PRESENTATION_PRIMITIVES.group,
        STANDARD_PRESENTATION_PRIMITIVES.rectangle,
        STANDARD_COLOR_SPACES.srgb
      ],
      metadata: { compositionCanvas: { width: 200, height: 100 } }
    };

    expect(selectionPolygon(graph, "node_rectangle", { width: 400, height: 200 })).toEqual([
      [160, 80],
      [240, 80],
      [240, 120],
      [160, 120]
    ]);
  });

  it("keeps Studio helpers typed against the current composition schema", () => {
    const document: StandardCompositionDocument = createStandardComposition();
    expect(document.schemaVersion).toBe(2);
  });

  it("stabilizes pointer-derived composition coordinates", () => {
    expect(roundCompositionCoordinate(1072.941176470588)).toBe(1072.941);
    expect(roundCompositionCoordinate(-0.0004)).toBe(0);
    expect(roundCompositionCoordinate(-17.4567)).toBe(-17.457);
  });
});
