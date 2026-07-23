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
  STANDARD_VALUE_TYPES,
  type StandardCompositionDocument,
  serializedTime
} from "@kineweave/standard-motion-document";
import { describe, expect, it } from "vitest";
import {
  compositionDurationSeconds,
  findLayerParent,
  flattenLayerTree,
  inspectorFields,
  keyframeSeconds,
  nodeAnchorSurfacePoint,
  roundCompositionCoordinate,
  selectionPolygon,
  sortedKeyframes,
  stageRotationDirection,
  surfaceDeltaToParentDelta,
  timelineProperties,
  updateNodeSelection
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

  it("builds deterministic timeline rows and exact keyframe ordering", () => {
    const document = createStandardComposition();
    document.data.nodes.node_headline!.properties.position = {
      kind: "track",
      trackId: "track_position"
    };
    document.data.tracks.track_position = {
      trackId: "track_position",
      valueType: STANDARD_VALUE_TYPES.vector2,
      target: { nodeId: "node_headline", property: "position" },
      keyframes: {
        keyframe_end: {
          keyframeId: "keyframe_end",
          time: serializedTime({ value: rational(5), domain: STANDARD_TIME_DOMAINS.seconds }),
          value: [1200, 620]
        },
        keyframe_start: {
          keyframeId: "keyframe_start",
          time: serializedTime({ value: rational(0), domain: STANDARD_TIME_DOMAINS.seconds }),
          value: [960, 620]
        }
      }
    };

    const position = timelineProperties(document, "node_headline").find(
      (item) => item.property === "position"
    );
    expect(position?.track?.trackId).toBe("track_position");
    expect(sortedKeyframes(position!.track!).map((keyframe) => keyframe.keyframeId)).toEqual([
      "keyframe_start",
      "keyframe_end"
    ]);
    expect(keyframeSeconds(position!.track!.keyframes.keyframe_end!)).toBe(5);
  });

  it("maps Stage deltas through rotated and non-uniform parent transforms", () => {
    const graph: ResolvedPresentationGraph = {
      presentationGraphVersion: PRESENTATION_GRAPH_VERSION,
      documentId: "document_main",
      time: timeValue(rational(0), STANDARD_TIME_DOMAINS.seconds),
      viewport: { width: 200, height: 100, pixelRatio: rational(1) },
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
            scale: [2, 1],
            rotation: 90,
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

    const delta = surfaceDeltaToParentDelta(
      graph,
      "node_rectangle",
      { width: 400, height: 200 },
      [-10, 40]
    );
    expect(delta?.[0]).toBeCloseTo(10);
    expect(delta?.[1]).toBeCloseTo(5);
    const anchor = nodeAnchorSurfacePoint(graph, "node_rectangle", { width: 400, height: 200 });
    expect(anchor?.[0]).toBeCloseTo(50);
    expect(anchor?.[1]).toBeCloseTo(250);

    const withParentScale = (scale: [number, number]): ResolvedPresentationGraph => ({
      ...graph,
      nodes: {
        ...graph.nodes,
        node_group: {
          ...graph.nodes.node_group!,
          transform: { ...graph.nodes.node_group!.transform, scale }
        }
      }
    });
    expect(stageRotationDirection(graph, "node_rectangle")).toBeUndefined();
    expect(stageRotationDirection(withParentScale([2, 2]), "node_rectangle")).toBe(1);
    expect(stageRotationDirection(withParentScale([2, -2]), "node_rectangle")).toBe(-1);

    const hiddenParent: ResolvedPresentationGraph = {
      ...graph,
      nodes: {
        ...graph.nodes,
        node_group: { ...graph.nodes.node_group!, visible: false }
      }
    };
    expect(
      selectionPolygon(hiddenParent, "node_rectangle", { width: 400, height: 200 })
    ).toBeUndefined();
  });

  it("keeps ancestor and descendant nodes out of the same multi-selection", () => {
    const document = createStandardComposition();

    expect(updateNodeSelection(document, ["node_scene"], "node_headline", "add")).toEqual([
      "node_headline"
    ]);
    expect(updateNodeSelection(document, ["node_headline"], "node_scene", "add")).toEqual([
      "node_scene"
    ]);
    expect(updateNodeSelection(document, ["node_panel"], "node_headline", "toggle")).toEqual([
      "node_panel",
      "node_headline"
    ]);
  });
});
