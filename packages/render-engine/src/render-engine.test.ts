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
import { RenderEngine, RenderRejectedError } from "./render-engine.js";
import {
  PRESENTATION_RENDERER_CAPABILITY_ID,
  PRESENTATION_RENDERER_CONTRACT_VERSION,
  type RendererProvider
} from "./types.js";

const PROVIDER_ID = "org.example.renderer/test";

function graph(
  requiredFeatures: readonly string[] = [
    STANDARD_PRESENTATION_PRIMITIVES.group,
    STANDARD_COLOR_SPACES.srgb
  ]
): ResolvedPresentationGraph {
  return {
    presentationGraphVersion: PRESENTATION_GRAPH_VERSION,
    documentId: "document_main",
    time: timeValue(rational(0), STANDARD_TIME_DOMAINS.seconds),
    viewport: { width: 100, height: 100, pixelRatio: rational(1) },
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
    requiredFeatures: [...requiredFeatures]
  };
}

function provider(): RendererProvider {
  return {
    descriptor: {
      capabilityId: PRESENTATION_RENDERER_CAPABILITY_ID,
      providerId: PROVIDER_ID,
      extensionId: "org.example.renderer-test",
      contractVersion: PRESENTATION_RENDERER_CONTRACT_VERSION,
      implementationVersion: "1.0.0",
      features: [
        STANDARD_PRESENTATION_PRIMITIVES.group,
        STANDARD_COLOR_SPACES.srgb
      ],
      lifetime: "project",
      environment: { hostKinds: ["cli"] }
    },
    render() {
      return { mediaType: "text/plain", fileExtension: ".txt", text: "ok" };
    }
  };
}

function engine(): RenderEngine {
  const renderer = provider();
  const engine = new RenderEngine({
    environment: { hostKind: "cli" },
    lockedBindings: {
      [PRESENTATION_RENDERER_CAPABILITY_ID]: {
        defaultProviderId: PROVIDER_ID,
        providers: {
          [PROVIDER_ID]: {
            providerId: PROVIDER_ID,
            contractVersion: renderer.descriptor.contractVersion,
            implementationVersion: renderer.descriptor.implementationVersion,
            features: renderer.descriptor.features
          }
        }
      }
    }
  });
  engine.registerRenderer(renderer);
  return engine;
}

describe("RenderEngine", () => {
  it("selects a locked compatible renderer and returns its artifact", async () => {
    const result = await engine().render({
      graph: graph(),
      evaluationMode: "deterministic"
    });

    expect(result.provider.providerId).toBe(PROVIDER_ID);
    expect(result.artifact).toMatchObject({
      mediaType: "text/plain",
      fileExtension: ".txt",
      text: "ok"
    });
  });

  it("rejects a locked renderer that lacks graph features", async () => {
    await expect(
      engine().render({
        graph: graph([
          STANDARD_PRESENTATION_PRIMITIVES.group,
          STANDARD_COLOR_SPACES.srgb,
          "org.example.presentation/particles"
        ]),
        evaluationMode: "deterministic"
      })
    ).rejects.toBeInstanceOf(RenderRejectedError);
  });
});
