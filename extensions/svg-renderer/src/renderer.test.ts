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
    const artifact = await svgRendererProvider.render({ graph: graph(), settings: {} });

    expect(artifact.mediaType).toBe("image/svg+xml");
    expect(artifact.text).toContain('viewBox="0 0 800 450"');
    expect(artifact.text).toContain("A &lt; B &amp; C");
    expect(artifact.text).toContain("translate(400 225)");
    expect(artifact.text.endsWith("\n")).toBe(true);
  });
});
