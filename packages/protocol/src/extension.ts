import type { CapabilityProviderDescriptor, HostKind } from "./capability.js";

export type ApiStability =
  | "experimental"
  | "provisional"
  | "stable"
  | "deprecated";

export type ExtensionRuntimeKind =
  | "workbench"
  | "worker"
  | "external-process"
  | "wasm"
  | "native";

export interface ExtensionDependency {
  readonly versionRange: string;
  readonly optional?: boolean;
}

export interface ExtensionEntrypoint {
  readonly runtime: ExtensionRuntimeKind;
  readonly module: string;
  readonly exportName?: string;
  readonly hostKinds?: readonly HostKind[];
}

export interface DocumentTypeContribution {
  readonly documentType: string;
  readonly schemaVersions: readonly number[];
}

export interface OperationTypeContribution {
  readonly operationType: string;
  readonly schemaVersions: readonly number[];
}

export interface DocumentEvaluatorContribution {
  readonly documentType: string;
  readonly schemaVersions: readonly number[];
  readonly presentationGraphVersions: readonly number[];
}

export interface ExtensionContributions {
  readonly capabilities?: readonly CapabilityProviderDescriptor[];
  readonly documentTypes?: readonly DocumentTypeContribution[];
  readonly documentEvaluators?: readonly DocumentEvaluatorContribution[];
  readonly operationTypes?: readonly OperationTypeContribution[];
}

export interface ExtensionManifest {
  readonly manifestVersion: 1;
  readonly extensionId: string;
  readonly version: string;
  readonly kineweaveVersion: string;
  readonly apiStability: ApiStability;
  readonly dependencies: Readonly<Record<string, ExtensionDependency>>;
  readonly entrypoints: readonly ExtensionEntrypoint[];
  readonly contributes: ExtensionContributions;
}

export type ExtensionLifecycleState =
  | "discovered"
  | "resolved"
  | "loaded"
  | "activated"
  | "deactivated"
  | "failed";
