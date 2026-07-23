import type { JsonObject } from "./json.js";

export interface ProjectDocumentDescriptor {
  readonly documentType: string;
  readonly schemaVersion: number;
  readonly path: string;
  readonly optional?: boolean;
}

export interface ProjectExtensionRequirement {
  readonly versionRange: string;
  readonly optional?: boolean;
  readonly source?:
    | { readonly kind: "package"; readonly packageName: string }
    | { readonly kind: "git"; readonly url: string; readonly revision?: string }
    | { readonly kind: "project"; readonly path: string };
}

export interface ProjectCapabilityRequirement {
  readonly contractVersion: string;
  readonly requiredFeatures?: readonly string[];
  readonly preferredProvider?: string;
  readonly optional?: boolean;
}

export interface OutputProfile {
  readonly target: string;
  readonly requiredFeatures?: readonly string[];
  readonly settings: JsonObject;
}

export interface KineWeaveProjectManifest {
  readonly projectFormatVersion: number;
  readonly projectId: string;
  readonly name: string;
  readonly entryDocumentId: string;
  readonly documents: Readonly<Record<string, ProjectDocumentDescriptor>>;
  readonly extensionRequirements: Readonly<Record<string, ProjectExtensionRequirement>>;
  readonly capabilityRequirements: Readonly<Record<string, ProjectCapabilityRequirement>>;
  readonly outputProfiles: Readonly<Record<string, OutputProfile>>;
  readonly metadata?: JsonObject;
}

export interface ProjectDocumentEnvelope<TData extends JsonObject = JsonObject> {
  readonly documentId: string;
  readonly documentType: string;
  readonly schemaVersion: number;
  readonly data: TData;
}

export interface LockedExtension {
  readonly version: string;
  readonly source: JsonObject;
  readonly integrity?: string;
}

export interface LockedCapabilityProvider {
  readonly providerId: string;
  readonly contractVersion: string;
  readonly implementationVersion: string;
  readonly features: readonly string[];
}

export interface LockedCapabilitySet {
  readonly defaultProviderId?: string;
  readonly providers: Readonly<Record<string, LockedCapabilityProvider>>;
}

export interface LockedResource {
  readonly contentHash: string;
  readonly source?: JsonObject;
}

export interface KineWeaveLockfile {
  readonly lockfileFormatVersion: number;
  readonly projectId: string;
  readonly protocolVersion: string;
  readonly extensions: Readonly<Record<string, LockedExtension>>;
  readonly capabilityBindings: Readonly<Record<string, LockedCapabilitySet>>;
  readonly resources: Readonly<Record<string, LockedResource>>;
}
