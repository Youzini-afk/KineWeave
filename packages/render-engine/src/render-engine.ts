import { resolveCapabilityPlan } from "@kineweave/capability-registry";
import { validatePresentationGraph } from "@kineweave/evaluation-engine";
import {
  hasErrorDiagnostics,
  type Diagnostic
} from "@kineweave/protocol";
import {
  PRESENTATION_RENDERER_CAPABILITY_ID,
  PRESENTATION_RENDERER_CONTRACT_VERSION,
  type RenderEngineOptions,
  type RenderExecutionRequest,
  type RenderExecutionResult,
  type RendererContributionRegistry,
  type RendererProvider
} from "./types.js";

function providerKey(provider: RendererProvider): string {
  return `${provider.descriptor.capabilityId}::${provider.descriptor.providerId}`;
}

function error(code: string, message: string): Diagnostic {
  return {
    severity: "error",
    code,
    message,
    source: "@kineweave/render-engine"
  };
}

export class RenderRejectedError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(message: string, diagnostics: readonly Diagnostic[]) {
    super(message);
    this.name = "RenderRejectedError";
    this.diagnostics = diagnostics;
  }
}

export class RenderEngine implements RendererContributionRegistry {
  readonly #options: RenderEngineOptions;
  readonly #providers = new Map<string, RendererProvider>();

  constructor(options: RenderEngineOptions) {
    this.#options = options;
  }

  registerRenderer(provider: RendererProvider): () => void {
    if (
      provider.descriptor.capabilityId !== PRESENTATION_RENDERER_CAPABILITY_ID
    ) {
      throw new TypeError(
        `Renderer ${provider.descriptor.providerId} must provide ${PRESENTATION_RENDERER_CAPABILITY_ID}`
      );
    }
    const key = providerKey(provider);
    if (this.#providers.has(key)) {
      throw new Error(`Renderer provider ${key} is already registered`);
    }
    this.#providers.set(key, provider);
    return () => this.#providers.delete(key);
  }

  async render(request: RenderExecutionRequest): Promise<RenderExecutionResult> {
    const graphDiagnostics = validatePresentationGraph(request.graph);
    if (hasErrorDiagnostics(graphDiagnostics)) {
      throw new RenderRejectedError(
        "Presentation graph is invalid",
        graphDiagnostics
      );
    }
    const providers = [...this.#providers.values()];
    const plan = resolveCapabilityPlan({
      requirements: [
        {
          capabilityId: PRESENTATION_RENDERER_CAPABILITY_ID,
          contractVersion: `^${PRESENTATION_RENDERER_CONTRACT_VERSION}`,
          requiredFeatures: request.graph.requiredFeatures,
          ...(request.preferredProviderIds === undefined
            ? {}
            : { preferredProviderIds: request.preferredProviderIds })
        }
      ],
      providers: providers.map((provider) => provider.descriptor),
      environment: {
        ...this.#options.environment,
        evaluationMode: request.evaluationMode
      },
      ...(this.#options.lockedBindings === undefined
        ? {}
        : { lockedBindings: this.#options.lockedBindings }),
      ...(this.#options.projectPreferences === undefined
        ? {}
        : { projectPreferences: this.#options.projectPreferences }),
      ...(this.#options.distributionDefaults === undefined
        ? {}
        : { distributionDefaults: this.#options.distributionDefaults })
    });
    if (hasErrorDiagnostics(plan.diagnostics)) {
      throw new RenderRejectedError("Renderer resolution failed", plan.diagnostics);
    }
    const binding = plan.bindings[PRESENTATION_RENDERER_CAPABILITY_ID];
    if (binding === undefined) {
      throw new RenderRejectedError("Renderer resolution returned no binding", [
        error(
          "render.renderer.missing",
          `No renderer is bound for ${PRESENTATION_RENDERER_CAPABILITY_ID}`
        )
      ]);
    }
    const provider = this.#providers.get(
      `${binding.descriptor.capabilityId}::${binding.descriptor.providerId}`
    );
    if (provider === undefined) {
      throw new RenderRejectedError("Resolved renderer is not active", [
        error(
          "render.renderer.inactive",
          `Renderer ${binding.descriptor.providerId} is not registered`
        )
      ]);
    }

    let artifact;
    try {
      artifact = await provider.render({
        graph: request.graph,
        settings: request.settings ?? {}
      });
    } catch (caught) {
      throw new RenderRejectedError("Renderer execution failed", [
        error(
          "render.renderer.failed",
          caught instanceof Error ? caught.message : String(caught)
        )
      ]);
    }
    if (
      artifact.mediaType.length === 0 ||
      !/^\.[A-Za-z0-9]+$/.test(artifact.fileExtension) ||
      typeof artifact.text !== "string"
    ) {
      throw new RenderRejectedError("Renderer returned an invalid artifact", [
        error(
          "render.artifact.invalid",
          "Render artifact requires mediaType, dot-prefixed fileExtension and text"
        )
      ]);
    }
    return {
      artifact: structuredClone(artifact),
      provider: structuredClone(binding.descriptor),
      diagnostics: structuredClone(plan.diagnostics)
    };
  }
}
