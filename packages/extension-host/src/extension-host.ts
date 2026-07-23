import {
  assertExtensionId,
  assertQualifiedName,
  type Diagnostic,
  type ExtensionEntrypoint,
  type ExtensionLifecycleState,
  type ExtensionManifest
} from "@kineweave/protocol";
import { compare, satisfies, valid, validRange } from "semver";
import type {
  DiscoveredExtension,
  ExtensionActivation,
  ExtensionHostOptions,
  ExtensionModule,
  ExtensionRequirementSet,
  ExtensionResolutionPlan,
  ExtensionStatus,
  ResolvedExtension
} from "./types.js";

const EXTENSION_RUNTIMES = new Set([
  "in-process",
  "workbench",
  "worker",
  "external-process",
  "wasm",
  "native"
]);
const HOST_KINDS = new Set(["desktop", "web", "cli", "render-node"]);

interface CatalogEntry<TContext> {
  readonly source: DiscoveredExtension<TContext>;
  state: ExtensionLifecycleState;
  module: ExtensionModule<TContext> | undefined;
  activation: ExtensionActivation | undefined;
  diagnostic: Diagnostic | undefined;
}

interface PendingExtensionRequirement {
  readonly extensionId: string;
  readonly versionRange: string;
  readonly optional: boolean;
  readonly stack: readonly string[];
}

type ExtensionSolveResult =
  | {
      readonly ok: true;
      readonly selected: Map<string, ResolvedExtension>;
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly Diagnostic[];
      readonly depth: number;
    };

function keyOf(manifest: ExtensionManifest): string {
  return `${manifest.extensionId}@${manifest.version}`;
}

function diagnostic(severity: Diagnostic["severity"], code: string, message: string): Diagnostic {
  return {
    severity,
    code,
    message,
    source: "@kineweave/extension-host"
  };
}

function extensionFailure(depth: number, item: Diagnostic): ExtensionSolveResult {
  return { ok: false, diagnostics: [item], depth };
}

function preferExtensionFailure(
  current: ExtensionSolveResult | undefined,
  candidate: ExtensionSolveResult
): ExtensionSolveResult {
  if (candidate.ok) return candidate;
  if (current === undefined || current.ok || candidate.depth > current.depth) {
    return candidate;
  }
  return current;
}

function validateManifest(manifest: ExtensionManifest): void {
  assertExtensionId(manifest.extensionId);
  if (manifest.manifestVersion !== 1) {
    throw new TypeError(`Unsupported extension manifest version ${manifest.manifestVersion}`);
  }
  if (valid(manifest.version) === null) {
    throw new TypeError(
      `Extension ${manifest.extensionId} has invalid version ${manifest.version}`
    );
  }
  if (validRange(manifest.kineweaveVersion) === null) {
    throw new TypeError(
      `Extension ${manifest.extensionId} has invalid KineWeave range ${manifest.kineweaveVersion}`
    );
  }
  for (const [dependencyId, dependency] of Object.entries(manifest.dependencies)) {
    assertExtensionId(dependencyId, "extension dependency id");
    if (validRange(dependency.versionRange) === null) {
      throw new TypeError(
        `Extension ${manifest.extensionId} has invalid dependency range ${dependency.versionRange}`
      );
    }
  }
  for (const [index, entrypoint] of manifest.entrypoints.entries()) {
    if (!EXTENSION_RUNTIMES.has(entrypoint.runtime)) {
      throw new TypeError(
        `Extension ${manifest.extensionId} entrypoint ${index} has invalid runtime ${entrypoint.runtime}`
      );
    }
    const pathSegments = entrypoint.module.split("/");
    if (
      !entrypoint.module.startsWith("./") ||
      entrypoint.module.includes("\\") ||
      entrypoint.module.includes("\0") ||
      pathSegments.includes("..")
    ) {
      throw new TypeError(
        `Extension ${manifest.extensionId} entrypoint ${index} must use a safe extension-relative module path`
      );
    }
    const hostKinds = entrypoint.hostKinds ?? [];
    if (
      hostKinds.some((hostKind) => !HOST_KINDS.has(hostKind)) ||
      new Set(hostKinds).size !== hostKinds.length
    ) {
      throw new TypeError(
        `Extension ${manifest.extensionId} entrypoint ${index} has invalid hostKinds`
      );
    }
  }

  const assertVersions = (versions: readonly number[], label: string): void => {
    if (
      versions.length === 0 ||
      versions.some((version) => !Number.isSafeInteger(version) || version <= 0) ||
      new Set(versions).size !== versions.length
    ) {
      throw new TypeError(`${label} must contain unique positive integer versions`);
    }
  };
  const contributionKeys = new Set<string>();
  for (const item of manifest.contributes.documentTypes ?? []) {
    assertQualifiedName(item.documentType, "document type contribution");
    assertVersions(item.schemaVersions, `${item.documentType} schemaVersions`);
    const key = `document:${item.documentType}`;
    if (contributionKeys.has(key)) throw new TypeError(`Duplicate contribution ${key}`);
    contributionKeys.add(key);
  }
  for (const item of manifest.contributes.documentEvaluators ?? []) {
    assertQualifiedName(item.documentType, "document evaluator contribution");
    assertVersions(item.schemaVersions, `${item.documentType} evaluator schemaVersions`);
    assertVersions(
      item.presentationGraphVersions,
      `${item.documentType} presentationGraphVersions`
    );
    const key = `evaluator:${item.documentType}`;
    if (contributionKeys.has(key)) throw new TypeError(`Duplicate contribution ${key}`);
    contributionKeys.add(key);
  }
  for (const item of manifest.contributes.operationTypes ?? []) {
    assertQualifiedName(item.operationType, "operation type contribution");
    assertVersions(item.schemaVersions, `${item.operationType} schemaVersions`);
    const key = `operation:${item.operationType}`;
    if (contributionKeys.has(key)) throw new TypeError(`Duplicate contribution ${key}`);
    contributionKeys.add(key);
  }
  for (const item of manifest.contributes.capabilities ?? []) {
    assertQualifiedName(item.capabilityId, "capability contribution id");
    assertQualifiedName(item.providerId, "capability provider contribution id");
    assertExtensionId(item.extensionId, "capability provider extension id");
    if (item.extensionId !== manifest.extensionId) {
      throw new TypeError(
        `Capability provider ${item.providerId} belongs to ${item.extensionId}, expected ${manifest.extensionId}`
      );
    }
    if (valid(item.contractVersion) === null || valid(item.implementationVersion) === null) {
      throw new TypeError(
        `Capability provider ${item.providerId} has invalid contract or implementation version`
      );
    }
    if (new Set(item.features).size !== item.features.length) {
      throw new TypeError(`Capability provider ${item.providerId} has duplicate features`);
    }
    for (const feature of item.features) {
      assertQualifiedName(feature, `feature of ${item.providerId}`);
    }
    const key = `capability:${item.providerId}`;
    if (contributionKeys.has(key)) throw new TypeError(`Duplicate contribution ${key}`);
    contributionKeys.add(key);
  }
}

export class ExtensionHost<TContext> {
  readonly #options: ExtensionHostOptions<TContext>;
  readonly #catalog = new Map<string, CatalogEntry<TContext>>();
  readonly #versionsById = new Map<string, string[]>();
  readonly #activationOrder: string[] = [];
  #lifecycleTail: Promise<void> = Promise.resolve();

  constructor(options: ExtensionHostOptions<TContext>) {
    if (valid(options.kineweaveVersion) === null) {
      throw new TypeError(`Invalid KineWeave host version ${options.kineweaveVersion}`);
    }
    if (options.supportedRuntimes.length === 0) {
      throw new TypeError("Extension host must declare at least one supported runtime");
    }
    this.#options = options;
  }

  #selectEntrypoint(manifest: ExtensionManifest): ExtensionEntrypoint | undefined {
    return manifest.entrypoints.find(
      (entrypoint) =>
        this.#options.supportedRuntimes.includes(entrypoint.runtime) &&
        (entrypoint.hostKinds === undefined ||
          entrypoint.hostKinds.includes(this.#options.hostKind))
    );
  }

  discover(source: DiscoveredExtension<TContext>): () => void {
    validateManifest(source.manifest);
    const key = keyOf(source.manifest);
    if (this.#catalog.has(key)) {
      throw new Error(`Extension ${key} is already discovered`);
    }
    this.#catalog.set(key, {
      source,
      state: "discovered",
      module: undefined,
      activation: undefined,
      diagnostic: undefined
    });
    const versions = this.#versionsById.get(source.manifest.extensionId) ?? [];
    versions.push(source.manifest.version);
    versions.sort((left, right) => compare(right, left));
    this.#versionsById.set(source.manifest.extensionId, versions);

    return () => {
      const entry = this.#catalog.get(key);
      if (
        entry?.state === "activated" ||
        entry?.state === "loaded" ||
        entry?.activation !== undefined ||
        this.#activationOrder.includes(key)
      ) {
        throw new Error(`Cannot forget activated extension ${key}`);
      }
      this.#catalog.delete(key);
      const current = this.#versionsById.get(source.manifest.extensionId) ?? [];
      const next = current.filter((version) => version !== source.manifest.version);
      if (next.length === 0) this.#versionsById.delete(source.manifest.extensionId);
      else this.#versionsById.set(source.manifest.extensionId, next);
    };
  }

  statuses(): readonly ExtensionStatus[] {
    return [...this.#catalog.values()]
      .map((entry) => ({
        extensionId: entry.source.manifest.extensionId,
        version: entry.source.manifest.version,
        state: entry.state,
        ...(entry.diagnostic === undefined ? {} : { diagnostic: entry.diagnostic })
      }))
      .sort((left, right) =>
        left.extensionId === right.extensionId
          ? compare(right.version, left.version)
          : left.extensionId.localeCompare(right.extensionId)
      );
  }

  resolve(requirementSet: ExtensionRequirementSet): ExtensionResolutionPlan {
    const solve = (
      pending: readonly PendingExtensionRequirement[],
      selected: ReadonlyMap<string, ResolvedExtension>,
      depth = 0
    ): ExtensionSolveResult => {
      const current = pending[0];
      if (current === undefined) {
        return { ok: true, selected: new Map(selected) };
      }
      const remaining = pending.slice(1);
      if (validRange(current.versionRange) === null) {
        return extensionFailure(
          depth,
          diagnostic(
            "error",
            "extension.requirement.version-invalid",
            `Invalid extension range ${current.extensionId}@${current.versionRange}`
          )
        );
      }
      if (current.stack.includes(current.extensionId)) {
        if (current.optional) {
          return solve(remaining, selected, depth + 1);
        }
        return extensionFailure(
          depth,
          diagnostic(
            "error",
            "extension.dependency.cycle",
            `Extension dependency cycle: ${[...current.stack, current.extensionId].join(" -> ")}`
          )
        );
      }

      const lockedVersion = requirementSet.lockedVersions?.[current.extensionId];
      const existing = selected.get(current.extensionId);
      if (existing !== undefined) {
        if (
          (lockedVersion === undefined || existing.manifest.version === lockedVersion) &&
          satisfies(existing.manifest.version, current.versionRange)
        ) {
          return solve(remaining, selected, depth + 1);
        }
        if (current.optional && lockedVersion === undefined) {
          return solve(remaining, selected, depth + 1);
        }
        return extensionFailure(
          depth,
          diagnostic(
            "error",
            lockedVersion === undefined
              ? "extension.dependency.version-conflict"
              : "extension.lockfile.unavailable",
            lockedVersion === undefined
              ? `${current.extensionId}@${existing.manifest.version} does not satisfy ${current.versionRange}`
              : `Locked extension ${current.extensionId}@${lockedVersion} conflicts with selected ${existing.manifest.version}`
          )
        );
      }

      const discoveredVersions = this.#versionsById.get(current.extensionId) ?? [];
      const candidateVersions =
        lockedVersion === undefined
          ? discoveredVersions.filter((version) => satisfies(version, current.versionRange))
          : discoveredVersions.includes(lockedVersion) &&
              satisfies(lockedVersion, current.versionRange)
            ? [lockedVersion]
            : [];
      if (lockedVersion !== undefined && candidateVersions.length === 0) {
        return extensionFailure(
          depth,
          diagnostic(
            "error",
            "extension.lockfile.unavailable",
            `Locked extension ${current.extensionId}@${lockedVersion} is unavailable or incompatible`
          )
        );
      }

      let bestFailure: ExtensionSolveResult | undefined;
      for (const version of candidateVersions) {
        const key = `${current.extensionId}@${version}`;
        const entry = this.#catalog.get(key)!;
        const manifest = entry.source.manifest;
        if (
          !satisfies(this.#options.kineweaveVersion, manifest.kineweaveVersion, {
            includePrerelease: true
          })
        ) {
          bestFailure = preferExtensionFailure(
            bestFailure,
            extensionFailure(
              depth,
              diagnostic(
                "error",
                "extension.engine.incompatible",
                `${key} requires KineWeave ${manifest.kineweaveVersion}, host is ${this.#options.kineweaveVersion}`
              )
            )
          );
          continue;
        }
        const entrypoint = this.#selectEntrypoint(manifest);
        if (manifest.entrypoints.length > 0 && entrypoint === undefined) {
          bestFailure = preferExtensionFailure(
            bestFailure,
            extensionFailure(
              depth,
              diagnostic(
                "error",
                "extension.entrypoint.unavailable",
                `${key} has no entrypoint for host ${this.#options.hostKind} and runtimes ${this.#options.supportedRuntimes.join(", ")}`
              )
            )
          );
          continue;
        }
        const resolved: ResolvedExtension =
          entrypoint === undefined ? { manifest, key } : { manifest, key, entrypoint };
        const nextSelected = new Map(selected);
        nextSelected.set(current.extensionId, resolved);
        const dependencyStack = [...current.stack, current.extensionId];
        const dependencies: PendingExtensionRequirement[] = Object.entries(manifest.dependencies)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([extensionId, dependency]) => ({
            extensionId,
            versionRange: dependency.versionRange,
            optional: dependency.optional === true,
            stack: dependencyStack
          }));
        const attempt = solve([...dependencies, ...remaining], nextSelected, depth + 1);
        if (attempt.ok) return attempt;
        bestFailure = preferExtensionFailure(bestFailure, attempt);
      }

      if (current.optional && lockedVersion === undefined) {
        const skipped = solve(remaining, selected, depth + 1);
        if (skipped.ok) return skipped;
        bestFailure = preferExtensionFailure(bestFailure, skipped);
      }
      if (bestFailure !== undefined) return bestFailure;
      return extensionFailure(
        depth,
        diagnostic(
          "error",
          "extension.requirement.unsatisfied",
          `No discovered version satisfies ${current.extensionId}@${current.versionRange}`
        )
      );
    };

    const initialRequirements: PendingExtensionRequirement[] = Object.entries(
      requirementSet.requirements
    )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([extensionId, requirement]) => ({
        extensionId,
        versionRange: requirement.versionRange,
        optional: requirement.optional === true,
        stack: []
      }));
    const result = solve(initialRequirements, new Map());
    if (!result.ok) {
      return { extensions: [], diagnostics: result.diagnostics };
    }

    const order: ResolvedExtension[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (resolved: ResolvedExtension): void => {
      if (visited.has(resolved.key)) return;
      if (visiting.has(resolved.key)) {
        throw new Error(`Resolved extension cycle at ${resolved.key}`);
      }
      visiting.add(resolved.key);
      for (const dependencyId of Object.keys(resolved.manifest.dependencies).sort()) {
        const dependency = result.selected.get(dependencyId);
        if (dependency !== undefined) visit(dependency);
      }
      visiting.delete(resolved.key);
      visited.add(resolved.key);
      order.push(resolved);
    };
    for (const resolved of [...result.selected.values()].sort((left, right) =>
      left.key.localeCompare(right.key)
    )) {
      visit(resolved);
    }
    for (const resolved of order) {
      const entry = this.#catalog.get(resolved.key)!;
      if (entry.state !== "activated") entry.state = "resolved";
    }
    return { extensions: order, diagnostics: [] };
  }

  activate(plan: ExtensionResolutionPlan): Promise<void> {
    return this.#runLifecycleExclusive(() => this.#activatePlan(plan));
  }

  async #activatePlan(plan: ExtensionResolutionPlan): Promise<void> {
    if (plan.diagnostics.some((item) => item.severity === "error")) {
      throw new Error("Cannot activate an invalid extension plan");
    }
    const activatedThisRun: string[] = [];
    try {
      for (const resolved of plan.extensions) {
        const entry = this.#catalog.get(resolved.key);
        if (entry === undefined) throw new Error(`Extension ${resolved.key} vanished`);
        if (entry.state === "activated") continue;
        try {
          entry.module ??= await entry.source.load(resolved.entrypoint);
          entry.state = "loaded";
          const context = await this.#options.createActivationContext(entry.source.manifest);
          entry.activation = (await entry.module.activate(context)) ?? undefined;
          entry.state = "activated";
          entry.diagnostic = undefined;
          this.#activationOrder.push(resolved.key);
          activatedThisRun.push(resolved.key);
        } catch (error) {
          entry.state = "failed";
          entry.diagnostic = diagnostic(
            "error",
            "extension.activation.failed",
            `${resolved.key}: ${error instanceof Error ? error.message : String(error)}`
          );
          throw error;
        }
      }
    } catch (error) {
      const rollbackFailures: unknown[] = [];
      for (const key of activatedThisRun.reverse()) {
        try {
          await this.#deactivate(key);
        } catch (caught) {
          rollbackFailures.push(caught);
        }
      }
      if (rollbackFailures.length > 0) {
        throw new AggregateError(
          [error, ...rollbackFailures],
          `Extension activation failed and ${rollbackFailures.length} rollback action(s) also failed`,
          { cause: error }
        );
      }
      throw error;
    }
  }

  deactivateAll(): Promise<void> {
    return this.#runLifecycleExclusive(async () => {
      const failures: unknown[] = [];
      const keys = [...new Set([...this.#activationOrder].reverse())];
      for (const key of keys) {
        try {
          await this.#deactivate(key);
        } catch (caught) {
          failures.push(caught);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, `Failed to deactivate ${failures.length} extension(s)`);
      }
    });
  }

  #runLifecycleExclusive(action: () => Promise<void>): Promise<void> {
    const run = this.#lifecycleTail.then(action, action);
    this.#lifecycleTail = run.catch(() => {});
    return run;
  }

  #removeFromActivationOrder(key: string): void {
    for (let index = this.#activationOrder.length - 1; index >= 0; index -= 1) {
      if (this.#activationOrder[index] === key) {
        this.#activationOrder.splice(index, 1);
      }
    }
  }

  async #deactivate(key: string): Promise<void> {
    const entry = this.#catalog.get(key);
    if (
      entry === undefined ||
      (entry.state !== "activated" && !(entry.state === "failed" && entry.activation !== undefined))
    ) {
      return;
    }
    try {
      await entry.activation?.deactivate?.();
      entry.activation = undefined;
      entry.state = "deactivated";
      entry.diagnostic = undefined;
      this.#removeFromActivationOrder(key);
    } catch (caught) {
      entry.state = "failed";
      entry.diagnostic = diagnostic(
        "error",
        "extension.deactivation.failed",
        `${key}: ${caught instanceof Error ? caught.message : String(caught)}`
      );
      throw caught;
    }
  }
}
