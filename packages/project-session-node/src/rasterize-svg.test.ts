import type { OutputFrameSequenceResult } from "@kineweave/project-session";
import {
  PRESENTATION_GRAPH_VERSION,
  type ResolvedPresentationGraph,
  rational,
  STANDARD_COLOR_SPACES,
  STANDARD_PRESENTATION_PRIMITIVES,
  STANDARD_TIME_DOMAINS,
  timeValue
} from "@kineweave/protocol";
import { describe, expect, it } from "vitest";
import { rasterizeSvgOutputFrame } from "./rasterize-svg.js";

function svgFrame(): OutputFrameSequenceResult {
  const time = timeValue(rational(0), STANDARD_TIME_DOMAINS.seconds);
  const graph: ResolvedPresentationGraph = {
    presentationGraphVersion: PRESENTATION_GRAPH_VERSION,
    documentId: "document_main",
    time,
    viewport: { width: 320, height: 100, pixelRatio: rational(1) },
    colorSpace: STANDARD_COLOR_SPACES.srgb,
    background: null,
    rootNodeIds: ["text"],
    nodes: {
      text: {
        presentationId: "text",
        primitive: STANDARD_PRESENTATION_PRIMITIVES.text,
        children: [],
        visible: true,
        opacity: 1,
        transform: {
          translation: [160, 50],
          scale: [1, 1],
          rotation: 0,
          anchor: [0, 0]
        },
        data: { text: "你好 KineWeave", fontSize: 32, fill: "#ffffff" }
      }
    },
    requiredFeatures: [STANDARD_PRESENTATION_PRIMITIVES.text]
  };
  return {
    frameIndex: 0,
    time,
    sourceCommitId: "commit_test",
    evaluation: { graph, diagnostics: [] },
    rendering: {
      artifact: {
        kind: "text",
        mediaType: "image/svg+xml",
        fileExtension: ".svg",
        text: `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="100"><text x="160" y="50" fill="#fff" font-family="sans-serif" font-size="32" text-anchor="middle" dominant-baseline="middle">你好 KineWeave</text></svg>`
      },
      provider: {
        capabilityId: "org.kineweave.renderer/output",
        providerId: "org.kineweave.renderer/svg",
        extensionId: "org.kineweave.extension/svg-renderer",
        contractVersion: "1.0.0",
        implementationVersion: "0.1.0",
        features: [],
        lifetime: "job"
      },
      diagnostics: []
    }
  };
}

describe("SVG output rasterization", () => {
  it("renders bundled Latin and Chinese glyphs to deterministic PNG bytes", async () => {
    const controller = new AbortController();
    const first = await rasterizeSvgOutputFrame(svgFrame(), { signal: controller.signal });
    const second = await rasterizeSvgOutputFrame(svgFrame(), { signal: controller.signal });
    expect(first.rendering.artifact.kind).toBe("binary");
    if (first.rendering.artifact.kind !== "binary" || second.rendering.artifact.kind !== "binary") {
      throw new Error("Expected binary PNG artifacts");
    }
    expect([...first.rendering.artifact.bytes.subarray(0, 8)]).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10
    ]);
    expect(first.rendering.artifact.bytes.byteLength).toBeGreaterThan(1_000);
    expect(first.rendering.artifact.bytes).toEqual(second.rendering.artifact.bytes);
    expect(first.rendering.artifact.metadata).toMatchObject({
      rasterizer: "@resvg/resvg-js",
      fontPackage: "@fontsource-variable/noto-sans-sc",
      width: 320,
      height: 100
    });
    controller.abort();
    await expect(
      rasterizeSvgOutputFrame(svgFrame(), { signal: controller.signal })
    ).rejects.toThrow(/aborted/i);
  });

  it("rejects raster work above the configured pixel budget", async () => {
    await expect(rasterizeSvgOutputFrame(svgFrame(), { maxPixels: 100 })).rejects.toThrow(
      /pixel safety limit/
    );
  });
});
