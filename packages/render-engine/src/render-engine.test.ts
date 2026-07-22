import { describe, expect, it, vi } from "vitest";
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
  INTERACTIVE_RENDERER_CAPABILITY_ID,
  INTERACTIVE_RENDERER_CONTRACT_VERSION,
  OUTPUT_RENDERER_CAPABILITY_ID,
  OUTPUT_RENDERER_CONTRACT_VERSION,
  type InteractiveRendererProvider,
  type OutputRendererProvider
} from "./types.js";

const OUTPUT_PROVIDER_ID = "org.example.renderer/output-test";
const INTERACTIVE_PROVIDER_ID = "org.example.renderer/interactive-test";
const OUTPUT_TARGET = "org.example.output/test";
const SURFACE_TYPE = "org.example.surface/test";

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

function outputProvider(): OutputRendererProvider {
  return {
    descriptor: {
      capabilityId: OUTPUT_RENDERER_CAPABILITY_ID,
      providerId: OUTPUT_PROVIDER_ID,
      extensionId: "org.example.renderer-output-test",
      contractVersion: OUTPUT_RENDERER_CONTRACT_VERSION,
      implementationVersion: "1.0.0",
      features: [
        OUTPUT_TARGET,
        STANDARD_PRESENTATION_PRIMITIVES.group,
        STANDARD_COLOR_SPACES.srgb
      ],
      lifetime: "project",
      environment: { hostKinds: ["cli"] }
    },
    renderOutput() {
      return {
        kind: "text",
        mediaType: "text/plain",
        fileExtension: ".txt",
        text: "ok"
      };
    }
  };
}

function outputEngine(): RenderEngine {
  const renderer = outputProvider();
  const engine = new RenderEngine({
    environment: { hostKind: "cli" },
    lockedBindings: {
      [OUTPUT_RENDERER_CAPABILITY_ID]: {
        defaultProviderId: OUTPUT_PROVIDER_ID,
        providers: {
          [OUTPUT_PROVIDER_ID]: {
            providerId: OUTPUT_PROVIDER_ID,
            contractVersion: renderer.descriptor.contractVersion,
            implementationVersion: renderer.descriptor.implementationVersion,
            features: renderer.descriptor.features
          }
        }
      }
    }
  });
  engine.registerOutputRenderer(renderer);
  return engine;
}

describe("RenderEngine output rendering", () => {
  it("selects a locked provider using graph and output-target features", async () => {
    const result = await outputEngine().renderOutput({
      graph: graph(),
      evaluationMode: "deterministic",
      target: OUTPUT_TARGET
    });

    expect(result.provider.providerId).toBe(OUTPUT_PROVIDER_ID);
    expect(result.artifact).toMatchObject({
      kind: "text",
      mediaType: "text/plain",
      fileExtension: ".txt",
      text: "ok"
    });
  });

  it("rejects a provider that lacks profile or graph features", async () => {
    await expect(
      outputEngine().renderOutput({
        graph: graph(),
        evaluationMode: "deterministic",
        target: OUTPUT_TARGET,
        requiredFeatures: ["org.example.output/alpha-channel"]
      })
    ).rejects.toBeInstanceOf(RenderRejectedError);
  });

  it("accepts binary artifacts without coercing their bytes to text", async () => {
    const renderer = outputProvider();
    const binary: OutputRendererProvider = {
      ...renderer,
      renderOutput: () => ({
        kind: "binary",
        mediaType: "application/octet-stream",
        fileExtension: ".bin",
        bytes: new Uint8Array([0, 255, 17])
      })
    };
    const engine = new RenderEngine({ environment: { hostKind: "cli" } });
    engine.registerOutputRenderer(binary);

    const result = await engine.renderOutput({
      graph: graph(),
      evaluationMode: "deterministic",
      target: OUTPUT_TARGET
    });
    expect(result.artifact.kind).toBe("binary");
    if (result.artifact.kind === "binary") {
      expect([...result.artifact.bytes]).toEqual([0, 255, 17]);
    }
  });
});

describe("RenderEngine interactive sessions", () => {
  it("owns frame, resize, hit-test and disposal lifecycle", async () => {
    const renderFrame = vi.fn();
    const resize = vi.fn();
    const hitTest = vi.fn(() => [
      { presentationId: "node_root", localPoint: [4, 6] as const }
    ]);
    const dispose = vi.fn();
    const provider: InteractiveRendererProvider = {
      descriptor: {
        capabilityId: INTERACTIVE_RENDERER_CAPABILITY_ID,
        providerId: INTERACTIVE_PROVIDER_ID,
        extensionId: "org.example.renderer-interactive-test",
        contractVersion: INTERACTIVE_RENDERER_CONTRACT_VERSION,
        implementationVersion: "1.0.0",
        features: [
          SURFACE_TYPE,
          STANDARD_PRESENTATION_PRIMITIVES.group,
          STANDARD_COLOR_SPACES.srgb
        ],
        lifetime: "project",
        environment: { hostKinds: ["desktop"] }
      },
      openSession({ graph: initialGraph }) {
        renderFrame({ graph: initialGraph });
        return { renderFrame, resize, hitTest, dispose };
      }
    };
    const engine = new RenderEngine({ environment: { hostKind: "desktop" } });
    engine.registerInteractiveRenderer(provider);
    const surface = {
      surfaceType: SURFACE_TYPE,
      width: 800,
      height: 450,
      pixelRatio: 2,
      resource: {}
    };

    const session = await engine.openInteractiveSession({
      graph: graph(),
      evaluationMode: "interactive",
      surface
    });
    await session.updateGraph({ graph: graph(), dirtyPresentationIds: ["node_root"] });
    await session.resize({ ...surface, width: 900 });
    await expect(session.hitTest({ x: 4, y: 6 })).resolves.toEqual([
      { presentationId: "node_root", localPoint: [4, 6] }
    ]);
    await session.dispose();
    await session.dispose();

    expect(renderFrame).toHaveBeenCalledTimes(2);
    expect(resize).toHaveBeenCalledOnce();
    expect(hitTest).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    await expect(session.updateGraph({ graph: graph() })).rejects.toMatchObject({
      diagnostics: [
        expect.objectContaining({ code: "render.interactive.session-disposed" })
      ]
    });
  });

  it("disposes all live sessions when the engine is disposed", async () => {
    const dispose = vi.fn();
    const provider: InteractiveRendererProvider = {
      descriptor: {
        capabilityId: INTERACTIVE_RENDERER_CAPABILITY_ID,
        providerId: INTERACTIVE_PROVIDER_ID,
        extensionId: "org.example.renderer-interactive-test",
        contractVersion: INTERACTIVE_RENDERER_CONTRACT_VERSION,
        implementationVersion: "1.0.0",
        features: [
          SURFACE_TYPE,
          STANDARD_PRESENTATION_PRIMITIVES.group,
          STANDARD_COLOR_SPACES.srgb
        ],
        lifetime: "project"
      },
      openSession: () => ({
        renderFrame() {},
        resize() {},
        hitTest: () => [],
        dispose
      })
    };
    const engine = new RenderEngine({ environment: { hostKind: "desktop" } });
    engine.registerInteractiveRenderer(provider);
    await engine.openInteractiveSession({
      graph: graph(),
      evaluationMode: "interactive",
      surface: {
        surfaceType: SURFACE_TYPE,
        width: 100,
        height: 100,
        pixelRatio: 1,
        resource: {}
      }
    });

    await engine.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
