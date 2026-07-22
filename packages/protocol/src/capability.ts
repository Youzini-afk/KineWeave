export type CapabilityLifetime =
  | "singleton"
  | "project"
  | "job"
  | "transient";

export type HostKind = "desktop" | "web" | "cli" | "render-node";
export type EvaluationMode = "interactive" | "deterministic" | "live";

export interface CapabilityEnvironmentConstraint {
  readonly hostKinds?: readonly HostKind[];
  readonly operatingSystems?: readonly string[];
  readonly architectures?: readonly string[];
  readonly evaluationModes?: readonly EvaluationMode[];
}

export interface CapabilityRequirement {
  readonly capabilityId: string;
  readonly contractVersion: string;
  readonly requiredFeatures?: readonly string[];
  readonly preferredProviderIds?: readonly string[];
  readonly optional?: boolean;
}

export interface CapabilityProviderDescriptor {
  readonly capabilityId: string;
  readonly providerId: string;
  readonly extensionId: string;
  readonly contractVersion: string;
  readonly implementationVersion: string;
  readonly features: readonly string[];
  readonly lifetime: CapabilityLifetime;
  readonly priority?: number;
  readonly requires?: readonly CapabilityRequirement[];
  readonly environment?: CapabilityEnvironmentConstraint;
  readonly supersedesProviderIds?: readonly string[];
}

export interface CapabilityEnvironment {
  readonly hostKind: HostKind;
  readonly operatingSystem?: string;
  readonly architecture?: string;
  readonly evaluationMode?: EvaluationMode;
}

export type CapabilityBindingReason =
  | "lockfile"
  | "requirement-preference"
  | "project-preference"
  | "distribution-default"
  | "priority";

export interface CapabilityBinding {
  readonly descriptor: CapabilityProviderDescriptor;
  readonly reason: CapabilityBindingReason;
}
