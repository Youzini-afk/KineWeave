import {
  HISTORY_FORMAT_VERSION,
  KINEWEAVE_PROTOCOL_VERSION,
  LOCKFILE_FORMAT_VERSION,
  PROJECT_FORMAT_VERSION,
  hasErrorDiagnostics,
  isResourceUri,
  type Diagnostic,
  type JsonObject,
  type KineWeaveHistory,
  type KineWeaveLockfile,
  type KineWeaveProjectManifest,
  type ProjectDocumentEnvelope
} from "@kineweave/protocol";
import { satisfies, valid, validRange } from "semver";
import { validateProjectPath } from "./project-path.js";
import {
  validateDocumentEnvelopeSchema,
  validateHistorySchema,
  validateLockfileSchema,
  validateProjectManifestSchema
} from "./schema-validation.js";

export interface ProjectBundle {
  readonly manifest: unknown;
  readonly lockfile: unknown;
  readonly history: unknown;
  readonly documents: Readonly<Record<string, unknown>>;
}

function error(
  code: string,
  message: string,
  jsonPointer?: string,
  documentId?: string
): Diagnostic {
  return {
    severity: "error",
    code,
    message,
    ...(jsonPointer === undefined ? {} : { jsonPointer }),
    ...(documentId === undefined ? {} : { documentId }),
    source: "@kineweave/project-format"
  };
}

export function validateProjectBundle(
  bundle: ProjectBundle
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [
    ...validateProjectManifestSchema(bundle.manifest),
    ...validateLockfileSchema(bundle.lockfile),
    ...validateHistorySchema(bundle.history)
  ];

  if (hasErrorDiagnostics(diagnostics)) return diagnostics;

  const manifest = bundle.manifest as KineWeaveProjectManifest;
  const lockfile = bundle.lockfile as KineWeaveLockfile;
  const history = bundle.history as KineWeaveHistory;

  if (manifest.projectFormatVersion !== PROJECT_FORMAT_VERSION) {
    diagnostics.push(
      error(
        "project.version.unsupported",
        `Project format ${manifest.projectFormatVersion} is not the current development format ${PROJECT_FORMAT_VERSION}`,
        "/projectFormatVersion"
      )
    );
  }
  if (lockfile.lockfileFormatVersion !== LOCKFILE_FORMAT_VERSION) {
    diagnostics.push(
      error(
        "lockfile.version.unsupported",
        `Lockfile format ${lockfile.lockfileFormatVersion} is not the current development format ${LOCKFILE_FORMAT_VERSION}`,
        "/lockfileFormatVersion"
      )
    );
  }
  if (history.historyFormatVersion !== HISTORY_FORMAT_VERSION) {
    diagnostics.push(
      error(
        "history.version.unsupported",
        `History format ${history.historyFormatVersion} is not the current development format ${HISTORY_FORMAT_VERSION}`,
        "/historyFormatVersion"
      )
    );
  }
  if (lockfile.protocolVersion !== KINEWEAVE_PROTOCOL_VERSION) {
    diagnostics.push(
      error(
        "lockfile.protocol.unsupported",
        `Protocol ${lockfile.protocolVersion} does not match ${KINEWEAVE_PROTOCOL_VERSION}`,
        "/protocolVersion"
      )
    );
  }
  if (manifest.projectId !== lockfile.projectId) {
    diagnostics.push(
      error(
        "project.lockfile.project-id-mismatch",
        "Manifest and lockfile projectId must match"
      )
    );
  }
  if (!(manifest.entryDocumentId in manifest.documents)) {
    diagnostics.push(
      error(
        "project.entry-document.missing",
        `Entry document ${manifest.entryDocumentId} is not declared`,
        "/entryDocumentId"
      )
    );
  }

  if (history.rootCommitId in history.commits) {
    diagnostics.push(
      error(
        "history.root.commit-duplicate",
        `Root commit id ${history.rootCommitId} must not appear in commits`,
        "/commits"
      )
    );
  }
  if (!(history.mainBranchName in history.branches)) {
    diagnostics.push(
      error(
        "history.main-branch.missing",
        `History is missing main branch ${history.mainBranchName}`,
        "/branches"
      )
    );
  }
  for (const [commitId, commit] of Object.entries(history.commits)) {
    if (commit.commitId !== commitId) {
      diagnostics.push(
        error(
          "history.commit.id-mismatch",
          `Commit key ${commitId} does not match commitId ${commit.commitId}`,
          `/commits/${commitId}/commitId`
        )
      );
    }
    for (const parentCommitId of commit.parentCommitIds) {
      if (
        parentCommitId !== history.rootCommitId &&
        !(parentCommitId in history.commits)
      ) {
        diagnostics.push(
          error(
            "history.commit.parent-missing",
            `Commit ${commitId} references unknown parent ${parentCommitId}`,
            `/commits/${commitId}/parentCommitIds`
          )
        );
      }
    }
  }
  for (const [branchName, headCommitId] of Object.entries(history.branches)) {
    if (branchName.includes("//")) {
      diagnostics.push(
        error(
          "history.branch.name-invalid",
          `Branch name ${branchName} cannot contain //`,
          `/branches/${branchName}`
        )
      );
    }
    if (
      headCommitId !== history.rootCommitId &&
      !(headCommitId in history.commits)
    ) {
      diagnostics.push(
        error(
          "history.branch.head-missing",
          `Branch ${branchName} points to unknown commit ${headCommitId}`,
          `/branches/${branchName}`
        )
      );
    }
  }

  const seenPaths = new Map<string, string>();
  for (const [documentId, descriptor] of Object.entries(manifest.documents)) {
    const pathError = validateProjectPath(descriptor.path);
    if (pathError !== undefined) {
      diagnostics.push(
        error(
          "project.document.path-invalid",
          pathError,
          `/documents/${documentId}/path`,
          documentId
        )
      );
    }
    const existing = seenPaths.get(descriptor.path);
    if (existing !== undefined) {
      diagnostics.push(
        error(
          "project.document.path-duplicate",
          `Documents ${existing} and ${documentId} use the same path ${descriptor.path}`,
          `/documents/${documentId}/path`,
          documentId
        )
      );
    } else {
      seenPaths.set(descriptor.path, documentId);
    }

    const rawDocument = bundle.documents[documentId];
    if (rawDocument === undefined) {
      if (descriptor.optional !== true) {
        diagnostics.push(
          error(
            "project.document.missing",
            `Required document ${documentId} is missing`,
            `/documents/${documentId}`,
            documentId
          )
        );
      }
      continue;
    }

    const documentDiagnostics = validateDocumentEnvelopeSchema(rawDocument);
    diagnostics.push(
      ...documentDiagnostics.map((item) => ({ ...item, documentId }))
    );
    if (hasErrorDiagnostics(documentDiagnostics)) continue;

    const document = rawDocument as ProjectDocumentEnvelope<JsonObject>;
    if (document.documentId !== documentId) {
      diagnostics.push(
        error(
          "project.document.id-mismatch",
          `Descriptor id ${documentId} does not match envelope id ${document.documentId}`,
          "/documentId",
          documentId
        )
      );
    }
    if (document.documentType !== descriptor.documentType) {
      diagnostics.push(
        error(
          "project.document.type-mismatch",
          `Descriptor type ${descriptor.documentType} does not match envelope type ${document.documentType}`,
          "/documentType",
          documentId
        )
      );
    }
    if (document.schemaVersion !== descriptor.schemaVersion) {
      diagnostics.push(
        error(
          "project.document.schema-version-mismatch",
          `Descriptor schema ${descriptor.schemaVersion} does not match envelope schema ${document.schemaVersion}`,
          "/schemaVersion",
          documentId
        )
      );
    }
  }

  for (const [extensionId, requirement] of Object.entries(
    manifest.extensionRequirements
  )) {
    if (validRange(requirement.versionRange) === null) {
      diagnostics.push(
        error(
          "project.extension.version-range-invalid",
          `Invalid extension version range ${requirement.versionRange}`,
          `/extensionRequirements/${extensionId}/versionRange`
        )
      );
      continue;
    }
    if (requirement.source?.kind === "project") {
      const pathError = validateProjectPath(requirement.source.path);
      if (pathError !== undefined) {
        diagnostics.push(
          error(
            "project.extension.path-invalid",
            pathError,
            `/extensionRequirements/${extensionId}/source/path`
          )
        );
      }
    }
    const locked = lockfile.extensions[extensionId];
    if (locked === undefined) {
      if (requirement.optional !== true) {
        diagnostics.push(
          error(
            "project.extension.unlocked",
            `Required extension ${extensionId} is not locked`,
            `/extensionRequirements/${extensionId}`
          )
        );
      }
    } else if (
      valid(locked.version) === null ||
      !satisfies(locked.version, requirement.versionRange, {
        includePrerelease: true
      })
    ) {
      diagnostics.push(
        error(
          "project.extension.lock-mismatch",
          `Locked extension ${extensionId}@${locked.version} does not satisfy ${requirement.versionRange}`,
          `/extensions/${extensionId}`
        )
      );
    }
  }

  for (const [capabilityId, requirement] of Object.entries(
    manifest.capabilityRequirements
  )) {
    if (validRange(requirement.contractVersion) === null) {
      diagnostics.push(
        error(
          "project.capability.version-range-invalid",
          `Invalid capability contract range ${requirement.contractVersion}`,
          `/capabilityRequirements/${capabilityId}/contractVersion`
        )
      );
      continue;
    }
    const bindingSet = lockfile.capabilityBindings[capabilityId];
    if (bindingSet === undefined) {
      if (requirement.optional !== true) {
        diagnostics.push(
          error(
            "project.capability.unbound",
            `Required capability ${capabilityId} is not bound`,
            `/capabilityRequirements/${capabilityId}`
          )
        );
      }
      continue;
    }
    const selectedProviderId =
      requirement.preferredProvider ?? bindingSet.defaultProviderId;
    const binding =
      selectedProviderId === undefined
        ? undefined
        : bindingSet.providers[selectedProviderId];
    if (binding === undefined) {
      diagnostics.push(
        error(
          "project.capability.default-provider-missing",
          `Capability ${capabilityId} has no usable default provider binding`,
          `/capabilityBindings/${capabilityId}`
        )
      );
      continue;
    }
    if (
      valid(binding.contractVersion) === null ||
      !satisfies(binding.contractVersion, requirement.contractVersion, {
        includePrerelease: true
      })
    ) {
      diagnostics.push(
        error(
          "project.capability.contract-mismatch",
          `Bound capability ${capabilityId}@${binding.contractVersion} does not satisfy ${requirement.contractVersion}`,
          `/capabilityBindings/${capabilityId}/contractVersion`
        )
      );
    }
    const features = new Set(binding.features);
    const missingFeatures = (requirement.requiredFeatures ?? []).filter(
      (feature) => !features.has(feature)
    );
    if (missingFeatures.length > 0) {
      diagnostics.push(
        error(
          "project.capability.features-missing",
          `Capability ${capabilityId} is missing features: ${missingFeatures.join(", ")}`,
          `/capabilityBindings/${capabilityId}/features`
        )
      );
    }
    if (
      requirement.preferredProvider !== undefined &&
      requirement.preferredProvider !== binding.providerId
    ) {
      diagnostics.push(
        error(
          "project.capability.provider-mismatch",
          `Capability ${capabilityId} is bound to ${binding.providerId}, expected ${requirement.preferredProvider}`,
          `/capabilityBindings/${capabilityId}/providerId`
        )
      );
    }
  }

  for (const resourceUri of Object.keys(lockfile.resources)) {
    if (!isResourceUri(resourceUri)) {
      diagnostics.push(
        error(
          "lockfile.resource.uri-invalid",
          `Invalid resource URI ${resourceUri}`,
          `/resources/${resourceUri}`
        )
      );
    }
  }

  return diagnostics;
}
