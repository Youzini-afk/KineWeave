import type {
  CapabilityEnvironment,
  CapabilityProviderDescriptor,
  Diagnostic,
  EvaluationMode,
  JsonObject,
  LockedCapabilitySet,
  ResolvedPresentationGraph
} from "@kineweave/protocol";

export const OUTPUT_RENDERER_CAPABILITY_ID = "org.kineweave.renderer/output";
export const OUTPUT_RENDERER_CONTRACT_VERSION = "1.0.0";

export const INTERACTIVE_RENDERER_CAPABILITY_ID = "org.kineweave.renderer/interactive";
export const INTERACTIVE_RENDERER_CONTRACT_VERSION = "1.0.0";

interface OutputRenderArtifactBase {
  readonly mediaType: string;
  readonly fileExtension: string;
  readonly metadata?: JsonObject;
}

export interface TextOutputRenderArtifact extends OutputRenderArtifactBase {
  readonly kind: "text";
  readonly text: string;
}

export interface BinaryOutputRenderArtifact extends OutputRenderArtifactBase {
  readonly kind: "binary";
  readonly bytes: Uint8Array;
}

export type OutputRenderArtifact = TextOutputRenderArtifact | BinaryOutputRenderArtifact;

export interface OutputRendererRequest {
  readonly graph: ResolvedPresentationGraph;
  readonly target: string;
  readonly settings: JsonObject;
}

export interface OutputRendererProvider {
  readonly descriptor: CapabilityProviderDescriptor;
  renderOutput(
    request: OutputRendererRequest
  ): OutputRenderArtifact | Promise<OutputRenderArtifact>;
}

/**
 * A host-owned interactive surface. The qualified surface type defines the
 * runtime shape of resource; renderer extensions validate and narrow it.
 */
export interface InteractiveRenderSurface {
  readonly surfaceType: string;
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly resource: unknown;
}

export interface InteractiveRendererOpenRequest {
  readonly graph: ResolvedPresentationGraph;
  readonly surface: InteractiveRenderSurface;
  readonly settings: JsonObject;
}

export interface InteractiveRendererFrameRequest {
  readonly graph: ResolvedPresentationGraph;
  readonly dirtyPresentationIds?: readonly string[];
}

export interface InteractiveHitTestRequest {
  /** Surface-local logical pixels, before device-pixel-ratio scaling. */
  readonly x: number;
  readonly y: number;
  readonly mode?: "topmost" | "all";
}

export interface InteractiveHit {
  readonly presentationId: string;
  readonly sourceResourceUri?: string;
  readonly localPoint: readonly [number, number];
}

/** Runtime object owned by an interactive renderer provider. */
export interface InteractiveRendererInstance {
  renderFrame(request: InteractiveRendererFrameRequest): void | Promise<void>;
  resize(surface: InteractiveRenderSurface): void | Promise<void>;
  hitTest(
    request: InteractiveHitTestRequest
  ): readonly InteractiveHit[] | Promise<readonly InteractiveHit[]>;
  dispose(): void | Promise<void>;
}

export interface InteractiveRendererProvider {
  readonly descriptor: CapabilityProviderDescriptor;
  openSession(
    request: InteractiveRendererOpenRequest
  ): InteractiveRendererInstance | Promise<InteractiveRendererInstance>;
}

export interface RendererContributionRegistry {
  registerOutputRenderer(provider: OutputRendererProvider): () => void;
  registerInteractiveRenderer(provider: InteractiveRendererProvider): () => void;
}

export interface RenderEngineOptions {
  readonly environment: Omit<CapabilityEnvironment, "evaluationMode">;
  readonly lockedBindings?: Readonly<Record<string, LockedCapabilitySet>>;
  readonly projectPreferences?: Readonly<Record<string, string>>;
  readonly distributionDefaults?: Readonly<Record<string, string>>;
}

export interface OutputRenderExecutionRequest {
  readonly graph: ResolvedPresentationGraph;
  readonly evaluationMode: EvaluationMode;
  readonly target: string;
  readonly requiredFeatures?: readonly string[];
  readonly settings?: JsonObject;
  readonly preferredProviderIds?: readonly string[];
}

export interface OutputRenderExecutionResult {
  readonly artifact: OutputRenderArtifact;
  readonly provider: CapabilityProviderDescriptor;
  readonly diagnostics: readonly Diagnostic[];
}

export interface InteractiveRenderSessionOpenRequest {
  readonly graph: ResolvedPresentationGraph;
  readonly evaluationMode: EvaluationMode;
  readonly surface: InteractiveRenderSurface;
  readonly requiredFeatures?: readonly string[];
  readonly settings?: JsonObject;
  readonly preferredProviderIds?: readonly string[];
}

/** Engine-managed session. Provider failures are normalized as diagnostics. */
export interface InteractiveRenderSession {
  readonly provider: CapabilityProviderDescriptor;
  readonly diagnostics: readonly Diagnostic[];
  updateGraph(request: InteractiveRendererFrameRequest): Promise<void>;
  resize(surface: InteractiveRenderSurface): Promise<void>;
  hitTest(request: InteractiveHitTestRequest): Promise<readonly InteractiveHit[]>;
  dispose(): Promise<void>;
}
