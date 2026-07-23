import {
  assertExtensionId,
  assertNamespacedId,
  type CapabilityBinding,
  type CapabilityBindingReason,
  type CapabilityEnvironment,
  type CapabilityProviderDescriptor,
  type CapabilityRequirement,
  type Diagnostic,
  type LockedCapabilitySet
} from "@kineweave/protocol";
import { compare, satisfies, valid, validRange } from "semver";

export interface CapabilityResolutionInput {
  readonly requirements: readonly CapabilityRequirement[];
  readonly providers: readonly CapabilityProviderDescriptor[];
  readonly environment: CapabilityEnvironment;
  readonly lockedBindings?: Readonly<Record<string, LockedCapabilitySet>>;
  readonly projectPreferences?: Readonly<Record<string, string>>;
  readonly distributionDefaults?: Readonly<Record<string, string>>;
}

export interface CapabilityResolutionPlan {
  readonly bindings: Readonly<Record<string, CapabilityBinding>>;
  readonly activationOrder: readonly CapabilityProviderDescriptor[];
  readonly diagnostics: readonly Diagnostic[];
}

interface PendingRequirement {
  readonly requirement: CapabilityRequirement;
  readonly stack: readonly string[];
}

type ResolutionResult =
  | {
      readonly ok: true;
      readonly bindings: Map<string, CapabilityBinding>;
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly Diagnostic[];
      readonly depth: number;
    };

function diagnostic(severity: Diagnostic["severity"], code: string, message: string): Diagnostic {
  return {
    severity,
    code,
    message,
    source: "@kineweave/capability-registry"
  };
}

function descriptorKey(descriptor: CapabilityProviderDescriptor): string {
  return `${descriptor.capabilityId}::${descriptor.providerId}`;
}

function supportsEnvironment(
  descriptor: CapabilityProviderDescriptor,
  environment: CapabilityEnvironment
): boolean {
  const constraint = descriptor.environment;
  if (constraint === undefined) return true;
  if (constraint.hostKinds !== undefined && !constraint.hostKinds.includes(environment.hostKind)) {
    return false;
  }
  if (
    constraint.operatingSystems !== undefined &&
    (environment.operatingSystem === undefined ||
      !constraint.operatingSystems.includes(environment.operatingSystem))
  ) {
    return false;
  }
  if (
    constraint.architectures !== undefined &&
    (environment.architecture === undefined ||
      !constraint.architectures.includes(environment.architecture))
  ) {
    return false;
  }
  if (
    constraint.evaluationModes !== undefined &&
    (environment.evaluationMode === undefined ||
      !constraint.evaluationModes.includes(environment.evaluationMode))
  ) {
    return false;
  }
  return true;
}

function satisfiesRequirement(
  descriptor: CapabilityProviderDescriptor,
  requirement: CapabilityRequirement,
  environment: CapabilityEnvironment
): boolean {
  const features = new Set(descriptor.features);
  return (
    descriptor.capabilityId === requirement.capabilityId &&
    satisfies(descriptor.contractVersion, requirement.contractVersion, {
      includePrerelease: true
    }) &&
    (requirement.requiredFeatures ?? []).every((feature) => features.has(feature)) &&
    supportsEnvironment(descriptor, environment)
  );
}

function validateProviderCatalog(providers: readonly CapabilityProviderDescriptor[]): void {
  const keys = new Set<string>();
  for (const provider of providers) {
    assertNamespacedId(provider.capabilityId, "capability id");
    assertNamespacedId(provider.providerId, "provider id");
    assertExtensionId(provider.extensionId);
    if (valid(provider.contractVersion) === null) {
      throw new TypeError(
        `Provider ${provider.providerId} has invalid contract version ${provider.contractVersion}`
      );
    }
    if (valid(provider.implementationVersion) === null) {
      throw new TypeError(
        `Provider ${provider.providerId} has invalid implementation version ${provider.implementationVersion}`
      );
    }
    const key = descriptorKey(provider);
    if (keys.has(key)) throw new Error(`Duplicate capability provider ${key}`);
    keys.add(key);
  }
}

function preference(
  requirement: CapabilityRequirement,
  input: CapabilityResolutionInput
): readonly { providerId: string; reason: CapabilityBindingReason }[] {
  const ordered: { providerId: string; reason: CapabilityBindingReason }[] = [];
  for (const providerId of requirement.preferredProviderIds ?? []) {
    ordered.push({ providerId, reason: "requirement-preference" });
  }
  const projectPreference = input.projectPreferences?.[requirement.capabilityId];
  if (projectPreference !== undefined) {
    ordered.push({ providerId: projectPreference, reason: "project-preference" });
  }
  const distributionDefault = input.distributionDefaults?.[requirement.capabilityId];
  if (distributionDefault !== undefined) {
    ordered.push({
      providerId: distributionDefault,
      reason: "distribution-default"
    });
  }
  return ordered.filter(
    (item, index, all) =>
      all.findIndex((candidate) => candidate.providerId === item.providerId) === index
  );
}

function candidateReason(
  providerId: string,
  preferred: readonly { providerId: string; reason: CapabilityBindingReason }[]
): CapabilityBindingReason {
  return preferred.find((item) => item.providerId === providerId)?.reason ?? "priority";
}

function orderedCandidates(
  requirement: CapabilityRequirement,
  input: CapabilityResolutionInput
): readonly CapabilityBinding[] {
  const preferred = preference(requirement, input);
  return input.providers
    .filter((provider) => satisfiesRequirement(provider, requirement, input.environment))
    .map((descriptor) => ({
      descriptor,
      reason: candidateReason(descriptor.providerId, preferred)
    }))
    .sort((left, right) => {
      const leftPreference = preferred.findIndex(
        (item) => item.providerId === left.descriptor.providerId
      );
      const rightPreference = preferred.findIndex(
        (item) => item.providerId === right.descriptor.providerId
      );
      const normalizedLeft = leftPreference === -1 ? Infinity : leftPreference;
      const normalizedRight = rightPreference === -1 ? Infinity : rightPreference;
      if (normalizedLeft !== normalizedRight) return normalizedLeft - normalizedRight;

      const leftSupersedes = left.descriptor.supersedesProviderIds?.length ?? 0;
      const rightSupersedes = right.descriptor.supersedesProviderIds?.length ?? 0;
      if (leftSupersedes !== rightSupersedes) {
        return rightSupersedes - leftSupersedes;
      }
      const priority = (right.descriptor.priority ?? 0) - (left.descriptor.priority ?? 0);
      if (priority !== 0) return priority;
      const version = compare(
        right.descriptor.implementationVersion,
        left.descriptor.implementationVersion
      );
      if (version !== 0) return version;
      return left.descriptor.providerId.localeCompare(right.descriptor.providerId);
    });
}

function lockedCandidate(
  requirement: CapabilityRequirement,
  input: CapabilityResolutionInput
): CapabilityBinding | undefined {
  const set = input.lockedBindings?.[requirement.capabilityId];
  if (set?.defaultProviderId === undefined) return undefined;
  const locked = set.providers[set.defaultProviderId];
  if (locked === undefined) return undefined;
  const descriptor = input.providers.find(
    (provider) =>
      provider.capabilityId === requirement.capabilityId &&
      provider.providerId === locked.providerId &&
      provider.contractVersion === locked.contractVersion &&
      provider.implementationVersion === locked.implementationVersion
  );
  return descriptor === undefined ||
    !satisfiesRequirement(descriptor, requirement, input.environment)
    ? undefined
    : { descriptor, reason: "lockfile" };
}

function failed(depth: number, item: Diagnostic): ResolutionResult {
  return { ok: false, diagnostics: [item], depth };
}

function preferFailure(
  current: ResolutionResult | undefined,
  candidate: ResolutionResult
): ResolutionResult {
  if (candidate.ok) return candidate;
  if (current === undefined || current.ok || candidate.depth > current.depth) {
    return candidate;
  }
  return current;
}

function solveRequirements(
  pending: readonly PendingRequirement[],
  input: CapabilityResolutionInput,
  bindings: ReadonlyMap<string, CapabilityBinding>,
  depth = 0
): ResolutionResult {
  const current = pending[0];
  if (current === undefined) {
    return { ok: true, bindings: new Map(bindings) };
  }
  const requirement = current.requirement;
  const remaining = pending.slice(1);

  if (validRange(requirement.contractVersion) === null) {
    return failed(
      depth,
      diagnostic(
        "error",
        "capability.requirement.version-invalid",
        `Invalid contract range ${requirement.contractVersion} for ${requirement.capabilityId}`
      )
    );
  }

  if (current.stack.includes(requirement.capabilityId)) {
    return failed(
      depth,
      diagnostic(
        "error",
        "capability.dependency.cycle",
        `Capability dependency cycle: ${[...current.stack, requirement.capabilityId].join(" -> ")}`
      )
    );
  }

  const existing = bindings.get(requirement.capabilityId);
  if (existing !== undefined) {
    if (satisfiesRequirement(existing.descriptor, requirement, input.environment)) {
      return solveRequirements(remaining, input, bindings, depth + 1);
    }
    if (requirement.optional === true) {
      return solveRequirements(remaining, input, bindings, depth + 1);
    }
    return failed(
      depth,
      diagnostic(
        "error",
        "capability.requirement.conflict",
        `Selected provider ${existing.descriptor.providerId} cannot satisfy another requirement for ${requirement.capabilityId}`
      )
    );
  }

  const lockedSet = input.lockedBindings?.[requirement.capabilityId];
  const locked = lockedCandidate(requirement, input);
  if (lockedSet?.defaultProviderId !== undefined && locked === undefined) {
    return failed(
      depth,
      diagnostic(
        "error",
        "capability.lockfile.unavailable",
        `Locked provider ${lockedSet.defaultProviderId} for ${requirement.capabilityId} is unavailable or incompatible`
      )
    );
  }

  const candidates = locked === undefined ? orderedCandidates(requirement, input) : [locked];

  let bestFailure: ResolutionResult | undefined;
  for (const candidate of candidates) {
    const nextBindings = new Map(bindings);
    nextBindings.set(requirement.capabilityId, candidate);
    const dependencyStack = [...current.stack, requirement.capabilityId];
    const dependencies: PendingRequirement[] = (candidate.descriptor.requires ?? []).map(
      (dependency) => ({
        requirement: dependency,
        stack: dependencyStack
      })
    );
    const attempt = solveRequirements(
      [...dependencies, ...remaining],
      input,
      nextBindings,
      depth + 1
    );
    if (attempt.ok) return attempt;
    bestFailure = preferFailure(bestFailure, attempt);
  }

  if (requirement.optional === true) {
    const skipped = solveRequirements(remaining, input, bindings, depth + 1);
    if (skipped.ok) return skipped;
    bestFailure = preferFailure(bestFailure, skipped);
  }

  if (bestFailure !== undefined) return bestFailure;
  return failed(
    depth,
    diagnostic(
      "error",
      "capability.provider.unsatisfied",
      `No provider satisfies ${requirement.capabilityId}@${requirement.contractVersion}`
    )
  );
}

function activationOrder(
  bindings: ReadonlyMap<string, CapabilityBinding>
): readonly CapabilityProviderDescriptor[] {
  const ordered: CapabilityProviderDescriptor[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(binding: CapabilityBinding): void {
    const key = descriptorKey(binding.descriptor);
    if (visited.has(key)) return;
    if (visiting.has(key)) throw new Error(`Provider activation cycle at ${key}`);
    visiting.add(key);
    for (const requirement of binding.descriptor.requires ?? []) {
      const dependency = bindings.get(requirement.capabilityId);
      if (dependency !== undefined) visit(dependency);
    }
    visiting.delete(key);
    visited.add(key);
    ordered.push(binding.descriptor);
  }

  for (const binding of [...bindings.values()].sort((left, right) =>
    descriptorKey(left.descriptor).localeCompare(descriptorKey(right.descriptor))
  )) {
    visit(binding);
  }
  return ordered;
}

export function resolveCapabilityPlan(input: CapabilityResolutionInput): CapabilityResolutionPlan {
  validateProviderCatalog(input.providers);
  const result = solveRequirements(
    input.requirements.map((requirement) => ({ requirement, stack: [] })),
    input,
    new Map()
  );
  const resolvedBindings = result.ok ? result.bindings : new Map<string, CapabilityBinding>();
  const bindings = Object.fromEntries(
    [...resolvedBindings.entries()].sort(([left], [right]) => left.localeCompare(right))
  );
  return {
    bindings,
    activationOrder: activationOrder(resolvedBindings),
    diagnostics: result.ok ? [] : result.diagnostics
  };
}
