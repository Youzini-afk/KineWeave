import type {
  CapabilityEnvironment,
  CapabilityProviderDescriptor,
  Diagnostic,
  EvaluationMode,
  JsonObject,
  LockedCapabilitySet,
  ResolvedPresentationGraph
} from "@kineweave/protocol";

export const PRESENTATION_RENDERER_CAPABILITY_ID =
  "org.kineweave.renderer/presentation";
export const PRESENTATION_RENDERER_CONTRACT_VERSION = "1.0.0";

export interface RenderArtifact {
  readonly mediaType: string;
  readonly fileExtension: string;
  readonly text: string;
  readonly metadata?: JsonObject;
}

export interface RendererRequest {
  readonly graph: ResolvedPresentationGraph;
  readonly settings: JsonObject;
}

export interface RendererProvider {
  readonly descriptor: CapabilityProviderDescriptor;
  render(request: RendererRequest): RenderArtifact | Promise<RenderArtifact>;
}

export interface RendererContributionRegistry {
  registerRenderer(provider: RendererProvider): () => void;
}

export interface RenderEngineOptions {
  readonly environment: Omit<CapabilityEnvironment, "evaluationMode">;
  readonly lockedBindings?: Readonly<Record<string, LockedCapabilitySet>>;
  readonly projectPreferences?: Readonly<Record<string, string>>;
  readonly distributionDefaults?: Readonly<Record<string, string>>;
}

export interface RenderExecutionRequest {
  readonly graph: ResolvedPresentationGraph;
  readonly evaluationMode: EvaluationMode;
  readonly settings?: JsonObject;
  readonly preferredProviderIds?: readonly string[];
}

export interface RenderExecutionResult {
  readonly artifact: RenderArtifact;
  readonly provider: CapabilityProviderDescriptor;
  readonly diagnostics: readonly Diagnostic[];
}
