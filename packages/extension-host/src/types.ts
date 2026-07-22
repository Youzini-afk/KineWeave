import type {
  Diagnostic,
  ExtensionEntrypoint,
  ExtensionLifecycleState,
  ExtensionManifest,
  ExtensionRuntimeKind,
  HostKind
} from "@kineweave/protocol";

export interface ExtensionActivation {
  readonly deactivate?: () => void | Promise<void>;
}

export interface ExtensionModule<TContext> {
  activate(
    context: TContext
  ): void | ExtensionActivation | Promise<void | ExtensionActivation>;
}

export interface DiscoveredExtension<TContext> {
  readonly manifest: ExtensionManifest;
  load(
    entrypoint: ExtensionEntrypoint | undefined
  ): ExtensionModule<TContext> | Promise<ExtensionModule<TContext>>;
}

export interface ExtensionRequirementSet {
  readonly requirements: Readonly<
    Record<string, { readonly versionRange: string; readonly optional?: boolean }>
  >;
  readonly lockedVersions?: Readonly<Record<string, string>>;
}

export interface ResolvedExtension {
  readonly manifest: ExtensionManifest;
  readonly key: string;
  readonly entrypoint?: ExtensionEntrypoint;
}

export interface ExtensionResolutionPlan {
  readonly extensions: readonly ResolvedExtension[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface ExtensionStatus {
  readonly extensionId: string;
  readonly version: string;
  readonly state: ExtensionLifecycleState;
  readonly diagnostic?: Diagnostic;
}

export interface ExtensionHostOptions<TContext> {
  readonly kineweaveVersion: string;
  readonly hostKind: HostKind;
  readonly supportedRuntimes: readonly ExtensionRuntimeKind[];
  readonly createActivationContext: (
    manifest: ExtensionManifest
  ) => TContext | Promise<TContext>;
}
