import type { KineWeaveExtensionContext } from "@kineweave/extension-api";
import type { DiscoveredExtension } from "@kineweave/extension-host";
import type { LoadedProjectBundle } from "@kineweave/project-format";
import type {
  CapabilityEnvironment,
  Diagnostic,
  DistributionProfileDescriptor,
  ExtensionRuntimeKind,
  HostKind
} from "@kineweave/protocol";

export interface KineWeaveDistributionProfile {
  readonly descriptor: DistributionProfileDescriptor;
  readonly extensions: readonly DiscoveredExtension<KineWeaveExtensionContext>[];
}

export interface ProjectSessionHost {
  readonly hostKind: HostKind;
  readonly supportedRuntimes: readonly ExtensionRuntimeKind[];
  readonly environment?: Omit<CapabilityEnvironment, "hostKind" | "evaluationMode">;
  readonly now: () => Date;
  readonly createCommitId: () => string;
}

export interface ProjectSessionOptions {
  readonly kineweaveVersion: string;
  readonly bundle: LoadedProjectBundle;
  readonly distribution: KineWeaveDistributionProfile;
  readonly host: ProjectSessionHost;
}

export interface ProjectSessionOpenResult<TSession> {
  readonly session?: TSession;
  readonly diagnostics: readonly Diagnostic[];
}
