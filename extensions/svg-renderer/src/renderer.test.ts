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
import { svgRendererProvider } from "./renderer.js";

function graph(): ResolvedPresentationGraph {
  return {
    presentationGraphVersion: PRESENTATION_GRAPH_VERSION,
    documentId: "document_main",
    time: timeValue(rational(1, 2), STANDARD_TIME_DOMAINS.seconds),
    viewport: { width: 800, height: 450, pixelRatio: rational(1) },
    colorSpace: STANDARD_COLOR_SPACES.srgb,
    background: "#111318",
    rootNodeIds: ["node_text"],
    nodes: {
      node_text: {
        presentationId: "node_text",
        primitive: STANDARD_PRESENTATION_PRIMITIVES.text,
        children: [],
        visible: true,
        opacity: 1,
        transform: {
          translation: [400, 225],
          scale: [1, 1],
          rotation: 0,
          anchor: [0, 0]
        },
        sourceResourceUri: "kw://project/document/document_main/node/node_text",
        data: {
          text: "A < B & C",
          fontSize: 48,
          fill: "#ffffff"
        }
      }
    },
    requiredFeatures: [
      STANDARD_PRESENTATION_PRIMITIVES.text,
      STANDARD_COLOR_SPACES.srgb
    ],
    metadata: {
      compositionCanvas: { width: 800, height: 450 }
    }
  };
}

describe("SVG renderer", () => {
  it("serializes standard primitives deterministically and escapes text", async () => {
    const artifact = await svgRendererProvider.renderOutput({
      graph: graph(),
      target: "org.kineweave.output/svg",
      settings: {}
    });

    expect(artifact.mediaType).toBe("image/svg+xml");
    expect(artifact.kind).toBe("text");
    if (artifact.kind === "text") {
      expect(artifact.text).toContain('viewBox="0 0 800 450"');
      expect(artifact.text).toContain("A &lt; B &amp; C");
      expect(artifact.text).toContain("translate(400 225)");
      expect(artifact.text.endsWith("\n")).toBe(true);
    }
  });

  it("serializes centered rectangle, ellipse and path geometry", async () => {
    const shapeGraph = graph();
    const common = shapeGraph.nodes.node_text!;
    const graphWithShapes: ResolvedPresentationGraph = {
      ...shapeGraph,
      rootNodeIds: ["node_rectangle", "node_ellipse", "node_path"],
      nodes: {
        node_rectangle: {
          ...common,
          presentationId: "node_rectangle",
          primitive: STANDARD_PRESENTATION_PRIMITIVES.rectangle,
          data: {
            width: 200,
            height: 100,
            cornerRadius: 12,
            fill: "#ff0000",
            stroke: "#ffffff",
            strokeWidth: 4
          }
        },
        node_ellipse: {
          ...common,
          presentationId: "node_ellipse",
          primitive: STANDARD_PRESENTATION_PRIMITIVES.ellipse,
          data: {
            radiusX: 80,
            radiusY: 40,
            fill: "#00ff00",
            stroke: "#00000000",
            strokeWidth: 0
          }
        },
        node_path: {
          ...common,
          presentationId: "node_path",
          primitive: STANDARD_PRESENTATION_PRIMITIVES.path,
          data: {
            path: "M 0 -20 L 20 20 L -20 20 Z",
            fill: "#0000ff",
            stroke: "#ffffff",
            strokeWidth: 2
          }
        }
      },
      requiredFeatures: [
        STANDARD_PRESENTATION_PRIMITIVES.rectangle,
        STANDARD_PRESENTATION_PRIMITIVES.ellipse,
        STANDARD_PRESENTATION_PRIMITIVES.path,
        STANDARD_COLOR_SPACES.srgb
      ]
    };
    const artifact = await svgRendererProvider.renderOutput({
      graph: graphWithShapes,
      target: "org.kineweave.output/svg",
      settings: {}
    });
    expect(artifact.kind).toBe("text");
    if (artifact.kind === "text") {
      expect(artifact.text).toContain('<rect id="node_rectangle"');
      expect(artifact.text).toContain('x="-100" y="-50"');
      expect(artifact.text).toContain('<ellipse id="node_ellipse"');
      expect(artifact.text).toContain('d="M 0 -20 L 20 20 L -20 20 Z"');
    }
  });
});
