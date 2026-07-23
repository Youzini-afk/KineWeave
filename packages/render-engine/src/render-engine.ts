import { resolveCapabilityPlan } from "@kineweave/capability-registry";
import { validatePresentationGraph } from "@kineweave/evaluation-engine";
import {
  assertQualifiedName,
  assertStableId,
  type CapabilityProviderDescriptor,
  type Diagnostic,
  type EvaluationMode,
  hasErrorDiagnostics
} from "@kineweave/protocol";
import {
  INTERACTIVE_RENDERER_CAPABILITY_ID,
  INTERACTIVE_RENDERER_CONTRACT_VERSION,
  type InteractiveHit,
  type InteractiveHitTestRequest,
  type InteractiveRendererFrameRequest,
  type InteractiveRendererInstance,
  type InteractiveRendererProvider,
  type InteractiveRenderSession,
  type InteractiveRenderSessionOpenRequest,
  type InteractiveRenderSurface,
  OUTPUT_RENDERER_CAPABILITY_ID,
  OUTPUT_RENDERER_CONTRACT_VERSION,
  type OutputRenderArtifact,
  type OutputRenderExecutionRequest,
  type OutputRenderExecutionResult,
  type OutputRendererProvider,
  type RenderEngineOptions,
  type RendererContributionRegistry
} from "./types.js";

type AnyRendererProvider = OutputRendererProvider | InteractiveRendererProvider;

function providerKey(provider: AnyRendererProvider): string {
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

function uniqueFeatures(...groups: readonly (readonly string[] | undefined)[]): string[] {
  return [...new Set(groups.flatMap((group) => group ?? []))].sort();
}

function validateSurface(surface: InteractiveRenderSurface): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  try {
    assertQualifiedName(surface.surfaceType, "interactive surface type");
  } catch (caught) {
    diagnostics.push(
      error(
        "render.interactive.surface-type-invalid",
        caught instanceof Error ? caught.message : String(caught)
      )
    );
  }
  for (const [name, value] of [
    ["width", surface.width],
    ["height", surface.height],
    ["pixelRatio", surface.pixelRatio]
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      diagnostics.push(
        error(
          "render.interactive.surface-dimension-invalid",
          `Interactive surface ${name} must be a positive finite number`
        )
      );
    }
  }
  if (surface.resource === null || surface.resource === undefined) {
    diagnostics.push(
      error(
        "render.interactive.surface-resource-missing",
        "Interactive surface requires a host-owned resource"
      )
    );
  }
  return diagnostics;
}

function validateArtifact(artifact: OutputRenderArtifact): readonly Diagnostic[] {
  if (
    typeof artifact.mediaType !== "string" ||
    artifact.mediaType.length === 0 ||
    !/^\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(artifact.fileExtension)
  ) {
    return [
      error(
        "render.output.artifact-invalid",
        "Output artifact requires a media type and a dot-prefixed file extension"
      )
    ];
  }
  if (artifact.kind === "text") {
    return typeof artifact.text === "string"
      ? []
      : [error("render.output.artifact-invalid", "Text output requires string text")];
  }
  if (artifact.kind === "binary") {
    return artifact.bytes instanceof Uint8Array
      ? []
      : [error("render.output.artifact-invalid", "Binary output requires Uint8Array bytes")];
  }
  return [error("render.output.artifact-invalid", "Output artifact kind must be text or binary")];
}

function validateHits(hits: readonly InteractiveHit[]): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const [index, hit] of hits.entries()) {
    try {
      assertStableId(hit.presentationId, `interactive hit ${index} presentationId`);
    } catch (caught) {
      diagnostics.push(
        error(
          "render.interactive.hit-invalid",
          caught instanceof Error ? caught.message : String(caught)
        )
      );
    }
    if (
      !Array.isArray(hit.localPoint) ||
      hit.localPoint.length !== 2 ||
      hit.localPoint.some(
        (coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate)
      )
    ) {
      diagnostics.push(
        error(
          "render.interactive.hit-invalid",
          `Interactive hit ${index} requires a finite two-dimensional localPoint`
        )
      );
    }
  }
  return diagnostics;
}

export class RenderRejectedError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(message: string, diagnostics: readonly Diagnostic[]) {
    super(message);
    this.name = "RenderRejectedError";
    this.diagnostics = diagnostics;
  }
}

class ManagedInteractiveRenderSession implements InteractiveRenderSession {
  readonly provider: CapabilityProviderDescriptor;
  readonly diagnostics: readonly Diagnostic[];
  readonly #instance: InteractiveRendererInstance;
  readonly #fixedRequiredFeatures: readonly string[];
  readonly #onDisposed: () => void;
  #surface: InteractiveRenderSurface;
  #disposed = false;

  constructor(options: {
    readonly provider: CapabilityProviderDescriptor;
    readonly diagnostics: readonly Diagnostic[];
    readonly instance: InteractiveRendererInstance;
    readonly surface: InteractiveRenderSurface;
    readonly fixedRequiredFeatures: readonly string[];
    readonly onDisposed: () => void;
  }) {
    this.provider = structuredClone(options.provider);
    this.diagnostics = structuredClone(options.diagnostics);
    this.#instance = options.instance;
    this.#surface = options.surface;
    this.#fixedRequiredFeatures = [...options.fixedRequiredFeatures];
    this.#onDisposed = options.onDisposed;
  }

  async updateGraph(request: InteractiveRendererFrameRequest): Promise<void> {
    this.#assertOpen();
    const graphDiagnostics = validatePresentationGraph(request.graph);
    if (hasErrorDiagnostics(graphDiagnostics)) {
      throw new RenderRejectedError("Presentation graph is invalid", graphDiagnostics);
    }
    this.#assertFeatures(
      uniqueFeatures(request.graph.requiredFeatures, this.#fixedRequiredFeatures, [
        this.#surface.surfaceType
      ])
    );
    try {
      await this.#instance.renderFrame(request);
    } catch (caught) {
      throw new RenderRejectedError("Interactive renderer frame failed", [
        error(
          "render.interactive.frame-failed",
          caught instanceof Error ? caught.message : String(caught)
        )
      ]);
    }
  }

  async resize(surface: InteractiveRenderSurface): Promise<void> {
    this.#assertOpen();
    const diagnostics = validateSurface(surface);
    if (hasErrorDiagnostics(diagnostics)) {
      throw new RenderRejectedError("Interactive surface is invalid", diagnostics);
    }
    this.#assertFeatures([surface.surfaceType]);
    try {
      await this.#instance.resize(surface);
      this.#surface = surface;
    } catch (caught) {
      throw new RenderRejectedError("Interactive renderer resize failed", [
        error(
          "render.interactive.resize-failed",
          caught instanceof Error ? caught.message : String(caught)
        )
      ]);
    }
  }

  async hitTest(request: InteractiveHitTestRequest): Promise<readonly InteractiveHit[]> {
    this.#assertOpen();
    if (
      !Number.isFinite(request.x) ||
      !Number.isFinite(request.y) ||
      (request.mode !== undefined && request.mode !== "topmost" && request.mode !== "all")
    ) {
      throw new RenderRejectedError("Interactive hit test is invalid", [
        error(
          "render.interactive.hit-request-invalid",
          "Hit testing requires finite coordinates and a supported mode"
        )
      ]);
    }
    let hits: readonly InteractiveHit[];
    try {
      hits = await this.#instance.hitTest(request);
    } catch (caught) {
      throw new RenderRejectedError("Interactive renderer hit test failed", [
        error(
          "render.interactive.hit-test-failed",
          caught instanceof Error ? caught.message : String(caught)
        )
      ]);
    }
    const diagnostics = validateHits(hits);
    if (hasErrorDiagnostics(diagnostics)) {
      throw new RenderRejectedError("Interactive renderer returned invalid hits", diagnostics);
    }
    return structuredClone(hits);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#onDisposed();
    try {
      await this.#instance.dispose();
    } catch (caught) {
      throw new RenderRejectedError("Interactive renderer disposal failed", [
        error(
          "render.interactive.dispose-failed",
          caught instanceof Error ? caught.message : String(caught)
        )
      ]);
    }
  }

  #assertFeatures(requiredFeatures: readonly string[]): void {
    const supported = new Set(this.provider.features);
    const missing = requiredFeatures.filter((feature) => !supported.has(feature));
    if (missing.length > 0) {
      throw new RenderRejectedError("Interactive renderer lacks required features", [
        error(
          "render.interactive.feature-missing",
          `${this.provider.providerId} does not support ${missing.join(", ")}`
        )
      ]);
    }
  }

  #assertOpen(): void {
    if (this.#disposed) {
      throw new RenderRejectedError("Interactive render session is disposed", [
        error(
          "render.interactive.session-disposed",
          "The interactive render session has already been disposed"
        )
      ]);
    }
  }
}

export class RenderEngine implements RendererContributionRegistry {
  readonly #options: RenderEngineOptions;
  readonly #outputProviders = new Map<string, OutputRendererProvider>();
  readonly #interactiveProviders = new Map<string, InteractiveRendererProvider>();
  readonly #sessions = new Set<ManagedInteractiveRenderSession>();
  #disposed = false;

  constructor(options: RenderEngineOptions) {
    this.#options = options;
  }

  registerOutputRenderer(provider: OutputRendererProvider): () => void {
    this.#assertOpen();
    return this.#registerProvider(provider, OUTPUT_RENDERER_CAPABILITY_ID, this.#outputProviders);
  }

  registerInteractiveRenderer(provider: InteractiveRendererProvider): () => void {
    this.#assertOpen();
    return this.#registerProvider(
      provider,
      INTERACTIVE_RENDERER_CAPABILITY_ID,
      this.#interactiveProviders
    );
  }

  async renderOutput(request: OutputRenderExecutionRequest): Promise<OutputRenderExecutionResult> {
    this.#assertOpen();
    const graphDiagnostics = validatePresentationGraph(request.graph);
    if (hasErrorDiagnostics(graphDiagnostics)) {
      throw new RenderRejectedError("Presentation graph is invalid", graphDiagnostics);
    }
    try {
      assertQualifiedName(request.target, "output render target");
    } catch (caught) {
      throw new RenderRejectedError("Output target is invalid", [
        error(
          "render.output.target-invalid",
          caught instanceof Error ? caught.message : String(caught)
        )
      ]);
    }
    const requiredFeatures = uniqueFeatures(
      request.graph.requiredFeatures,
      request.requiredFeatures,
      [request.target]
    );
    const { provider, descriptor, diagnostics } = this.#resolveProvider(
      OUTPUT_RENDERER_CAPABILITY_ID,
      OUTPUT_RENDERER_CONTRACT_VERSION,
      this.#outputProviders,
      request.evaluationMode,
      requiredFeatures,
      request.preferredProviderIds
    );

    let artifact: OutputRenderArtifact;
    try {
      artifact = await provider.renderOutput({
        graph: request.graph,
        target: request.target,
        settings: request.settings ?? {}
      });
    } catch (caught) {
      throw new RenderRejectedError("Output renderer execution failed", [
        error(
          "render.output.renderer-failed",
          caught instanceof Error ? caught.message : String(caught)
        )
      ]);
    }
    const artifactDiagnostics = validateArtifact(artifact);
    if (hasErrorDiagnostics(artifactDiagnostics)) {
      throw new RenderRejectedError(
        "Output renderer returned an invalid artifact",
        artifactDiagnostics
      );
    }
    return {
      artifact: structuredClone(artifact),
      provider: structuredClone(descriptor),
      diagnostics: structuredClone(diagnostics)
    };
  }

  async openInteractiveSession(
    request: InteractiveRenderSessionOpenRequest
  ): Promise<InteractiveRenderSession> {
    this.#assertOpen();
    const graphDiagnostics = validatePresentationGraph(request.graph);
    if (hasErrorDiagnostics(graphDiagnostics)) {
      throw new RenderRejectedError("Presentation graph is invalid", graphDiagnostics);
    }
    const surfaceDiagnostics = validateSurface(request.surface);
    if (hasErrorDiagnostics(surfaceDiagnostics)) {
      throw new RenderRejectedError("Interactive surface is invalid", surfaceDiagnostics);
    }
    const fixedRequiredFeatures = uniqueFeatures(request.requiredFeatures);
    const { provider, descriptor, diagnostics } = this.#resolveProvider(
      INTERACTIVE_RENDERER_CAPABILITY_ID,
      INTERACTIVE_RENDERER_CONTRACT_VERSION,
      this.#interactiveProviders,
      request.evaluationMode,
      uniqueFeatures(request.graph.requiredFeatures, fixedRequiredFeatures, [
        request.surface.surfaceType
      ]),
      request.preferredProviderIds
    );
    let instance: InteractiveRendererInstance;
    try {
      instance = await provider.openSession({
        graph: request.graph,
        surface: request.surface,
        settings: request.settings ?? {}
      });
    } catch (caught) {
      throw new RenderRejectedError("Interactive renderer failed to open", [
        error(
          "render.interactive.open-failed",
          caught instanceof Error ? caught.message : String(caught)
        )
      ]);
    }
    let managed!: ManagedInteractiveRenderSession;
    managed = new ManagedInteractiveRenderSession({
      provider: descriptor,
      diagnostics,
      instance,
      surface: request.surface,
      fixedRequiredFeatures,
      onDisposed: () => this.#sessions.delete(managed)
    });
    this.#sessions.add(managed);
    return managed;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const failures: Diagnostic[] = [];
    for (const session of [...this.#sessions]) {
      try {
        await session.dispose();
      } catch (caught) {
        if (caught instanceof RenderRejectedError) failures.push(...caught.diagnostics);
        else {
          failures.push(
            error(
              "render.interactive.dispose-failed",
              caught instanceof Error ? caught.message : String(caught)
            )
          );
        }
      }
    }
    this.#outputProviders.clear();
    this.#interactiveProviders.clear();
    if (failures.length > 0) {
      throw new RenderRejectedError("Render engine disposal failed", failures);
    }
  }

  #registerProvider<T extends AnyRendererProvider>(
    provider: T,
    capabilityId: string,
    providers: Map<string, T>
  ): () => void {
    if (provider.descriptor.capabilityId !== capabilityId) {
      throw new TypeError(
        `Renderer ${provider.descriptor.providerId} must provide ${capabilityId}`
      );
    }
    const key = providerKey(provider);
    if (providers.has(key)) {
      throw new Error(`Renderer provider ${key} is already registered`);
    }
    providers.set(key, provider);
    let registered = true;
    return () => {
      if (!registered) return;
      providers.delete(key);
      registered = false;
    };
  }

  #resolveProvider<T extends AnyRendererProvider>(
    capabilityId: string,
    contractVersion: string,
    providers: ReadonlyMap<string, T>,
    evaluationMode: EvaluationMode,
    requiredFeatures: readonly string[],
    preferredProviderIds?: readonly string[]
  ): {
    readonly provider: T;
    readonly descriptor: CapabilityProviderDescriptor;
    readonly diagnostics: readonly Diagnostic[];
  } {
    const plan = resolveCapabilityPlan({
      requirements: [
        {
          capabilityId,
          contractVersion: `^${contractVersion}`,
          requiredFeatures,
          ...(preferredProviderIds === undefined ? {} : { preferredProviderIds })
        }
      ],
      providers: [...providers.values()].map((provider) => provider.descriptor),
      environment: {
        ...this.#options.environment,
        evaluationMode
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
    const binding = plan.bindings[capabilityId];
    if (binding === undefined) {
      throw new RenderRejectedError("Renderer resolution returned no binding", [
        error("render.renderer.missing", `No renderer is bound for ${capabilityId}`)
      ]);
    }
    const provider = providers.get(
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
    return {
      provider,
      descriptor: binding.descriptor,
      diagnostics: plan.diagnostics
    };
  }

  #assertOpen(): void {
    if (this.#disposed) throw new Error("Render engine is disposed");
  }
}
