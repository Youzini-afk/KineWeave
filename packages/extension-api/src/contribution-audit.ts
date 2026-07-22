import type { DocumentEvaluator } from "@kineweave/evaluation-engine";
import type {
  CapabilityProviderDescriptor,
  Diagnostic,
  ExtensionManifest,
  JsonValue
} from "@kineweave/protocol";
import type {
  InteractiveRendererProvider,
  OutputRendererProvider
} from "@kineweave/render-engine";
import type {
  DocumentValidator,
  OperationHandler
} from "@kineweave/transaction-engine";
import type { KineWeaveExtensionContext } from "./context.js";

export interface KineWeaveExtensionContributionAudit {
  readonly context: KineWeaveExtensionContext;
  diagnostics(): readonly Diagnostic[];
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
}

function trackedRegistration<T>(
  value: T,
  key: string,
  active: Map<string, T>,
  register: (value: T) => () => void
): () => void {
  const dispose = register(value);
  active.set(key, value);
  let registered = true;
  return () => {
    if (!registered) return;
    dispose();
    active.delete(key);
    registered = false;
  };
}

function versionedKey(type: string, version: number): string {
  return `${type}@${version}`;
}

function evaluatorKey(evaluator: {
  readonly documentType: string;
  readonly schemaVersion: number;
  readonly presentationGraphVersions: readonly number[];
}): string {
  return `${versionedKey(evaluator.documentType, evaluator.schemaVersion)}->${[
    ...evaluator.presentationGraphVersions
  ].sort((left, right) => left - right).join(",")}`;
}

function difference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((item) => !right.has(item)).sort();
}

export function createKineWeaveExtensionContributionAudit(
  context: KineWeaveExtensionContext
): KineWeaveExtensionContributionAudit {
  const operations = new Map<string, OperationHandler>();
  const documents = new Map<string, DocumentValidator>();
  const evaluators = new Map<string, DocumentEvaluator>();
  const capabilities = new Map<string, CapabilityProviderDescriptor>();

  const trackedContext: KineWeaveExtensionContext = {
    ...context,
    transactions: {
      registerOperationHandler: (handler) =>
        trackedRegistration(
          handler,
          versionedKey(handler.operationType, handler.schemaVersion),
          operations,
          (value) => context.transactions.registerOperationHandler(value)
        ),
      registerDocumentValidator: (validator) =>
        trackedRegistration(
          validator,
          versionedKey(validator.documentType, validator.schemaVersion),
          documents,
          (value) => context.transactions.registerDocumentValidator(value)
        ),
      registerCrossDocumentValidator: (validator) =>
        context.transactions.registerCrossDocumentValidator(validator),
      registerPrecondition: (type, evaluator) =>
        context.transactions.registerPrecondition(type, evaluator)
    },
    evaluation: {
      registerDocumentEvaluator: (evaluator) =>
        trackedRegistration(
          evaluator,
          evaluatorKey(evaluator),
          evaluators,
          (value) => context.evaluation.registerDocumentEvaluator(value)
        )
    },
    rendering: {
      registerOutputRenderer: (provider: OutputRendererProvider) =>
        trackedRegistration(
          provider.descriptor,
          provider.descriptor.providerId,
          capabilities,
          () => context.rendering.registerOutputRenderer(provider)
        ),
      registerInteractiveRenderer: (provider: InteractiveRendererProvider) =>
        trackedRegistration(
          provider.descriptor,
          provider.descriptor.providerId,
          capabilities,
          () => context.rendering.registerInteractiveRenderer(provider)
        )
    }
  };

  return {
    context: trackedContext,
    diagnostics() {
      const manifest: ExtensionManifest = context.manifest;
      const expectedOperations = new Set(
        (manifest.contributes.operationTypes ?? []).flatMap((item) =>
          item.schemaVersions.map((version) => versionedKey(item.operationType, version))
        )
      );
      const expectedDocuments = new Set(
        (manifest.contributes.documentTypes ?? []).flatMap((item) =>
          item.schemaVersions.map((version) => versionedKey(item.documentType, version))
        )
      );
      const expectedEvaluators = new Set(
        (manifest.contributes.documentEvaluators ?? []).flatMap((item) =>
          item.schemaVersions.map((schemaVersion) =>
            evaluatorKey({
              documentType: item.documentType,
              schemaVersion,
              presentationGraphVersions: item.presentationGraphVersions
            })
          )
        )
      );
      const actualOperations = new Set(operations.keys());
      const actualDocuments = new Set(documents.keys());
      const actualEvaluators = new Set(evaluators.keys());
      const result: Diagnostic[] = [];
      const compareSets = (
        category: string,
        expected: ReadonlySet<string>,
        actual: ReadonlySet<string>
      ): void => {
        for (const item of difference(expected, actual)) {
          result.push({
            severity: "error",
            code: "extension.contribution.missing",
            message: `${manifest.extensionId} declares ${category} ${item} but did not register it`,
            source: "@kineweave/extension-api"
          });
        }
        for (const item of difference(actual, expected)) {
          result.push({
            severity: "error",
            code: "extension.contribution.undeclared",
            message: `${manifest.extensionId} registered undeclared ${category} ${item}`,
            source: "@kineweave/extension-api"
          });
        }
      };
      compareSets("operation", expectedOperations, actualOperations);
      compareSets("document type", expectedDocuments, actualDocuments);
      compareSets("document evaluator", expectedEvaluators, actualEvaluators);

      const expectedCapabilities = new Map(
        (manifest.contributes.capabilities ?? []).map((descriptor) => [
          descriptor.providerId,
          descriptor
        ])
      );
      compareSets(
        "capability provider",
        new Set(expectedCapabilities.keys()),
        new Set(capabilities.keys())
      );
      for (const [providerId, actual] of capabilities) {
        const expected = expectedCapabilities.get(providerId);
        if (
          expected !== undefined &&
          canonicalJson(expected as unknown as JsonValue) !==
            canonicalJson(actual as unknown as JsonValue)
        ) {
          result.push({
            severity: "error",
            code: "extension.contribution.mismatch",
            message: `${manifest.extensionId} registered capability provider ${providerId} with a descriptor that differs from its manifest`,
            source: "@kineweave/extension-api"
          });
        }
        if (actual.extensionId !== manifest.extensionId) {
          result.push({
            severity: "error",
            code: "extension.contribution.owner-mismatch",
            message: `${providerId} belongs to ${actual.extensionId}, expected ${manifest.extensionId}`,
            source: "@kineweave/extension-api"
          });
        }
      }
      return result;
    }
  };
}
