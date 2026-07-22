import { describe, expect, it } from "vitest";
import type { ExtensionManifest } from "@kineweave/protocol";
import {
  PRESENTATION_RENDERER_CAPABILITY_ID,
  PRESENTATION_RENDERER_CONTRACT_VERSION
} from "@kineweave/render-engine";
import {
  createKineWeaveExtensionContributionAudit,
  type KineWeaveExtensionContext
} from "./index.js";

const documentType = "org.example.motion/composition";
const operationType = "org.example.motion/set-value";
const provider = {
  descriptor: {
    capabilityId: PRESENTATION_RENDERER_CAPABILITY_ID,
    providerId: "org.example.renderer/test",
    extensionId: "org.example.extension",
    contractVersion: PRESENTATION_RENDERER_CONTRACT_VERSION,
    implementationVersion: "1.0.0",
    features: ["org.example.presentation/test"],
    lifetime: "project" as const
  },
  render() {
    return { mediaType: "text/plain", fileExtension: ".txt", text: "ok" };
  }
};

const manifest: ExtensionManifest = {
  manifestVersion: 1,
  extensionId: "org.example.extension",
  version: "1.0.0",
  kineweaveVersion: "^0.1.0",
  apiStability: "experimental",
  dependencies: {},
  entrypoints: [],
  contributes: {
    documentTypes: [{ documentType, schemaVersions: [1] }],
    documentEvaluators: [
      {
        documentType,
        schemaVersions: [1],
        presentationGraphVersions: [1]
      }
    ],
    operationTypes: [{ operationType, schemaVersions: [1] }],
    capabilities: [provider.descriptor]
  }
};

function context(value: ExtensionManifest = manifest): KineWeaveExtensionContext {
  return {
    manifest: value,
    hostKind: "cli",
    transactions: {
      registerOperationHandler: () => () => {},
      registerDocumentValidator: () => () => {},
      registerCrossDocumentValidator: () => () => {},
      registerPrecondition: () => () => {}
    },
    evaluation: { registerDocumentEvaluator: () => () => {} },
    rendering: { registerRenderer: () => () => {} }
  };
}

describe("KineWeave extension contribution audit", () => {
  it("accepts active registrations that exactly match the manifest", () => {
    const audit = createKineWeaveExtensionContributionAudit(context());
    audit.context.transactions.registerOperationHandler({
      operationType,
      schemaVersion: 1,
      prepare: () => ({})
    });
    audit.context.transactions.registerDocumentValidator({
      documentType,
      schemaVersion: 1,
      validate: () => []
    });
    audit.context.evaluation.registerDocumentEvaluator({
      documentType,
      schemaVersion: 1,
      presentationGraphVersions: [1],
      evaluate: () => {
        throw new Error("not executed by this test");
      }
    });
    audit.context.rendering.registerRenderer(provider);

    expect(audit.diagnostics()).toEqual([]);
  });

  it("reports declared-but-missing and active-but-undeclared registrations", () => {
    const missing = createKineWeaveExtensionContributionAudit(context());
    expect(missing.diagnostics()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "extension.contribution.missing" })
      ])
    );

    const emptyManifest: ExtensionManifest = { ...manifest, contributes: {} };
    const undeclared = createKineWeaveExtensionContributionAudit(
      context(emptyManifest)
    );
    undeclared.context.transactions.registerOperationHandler({
      operationType,
      schemaVersion: 1,
      prepare: () => ({})
    });
    expect(undeclared.diagnostics()).toEqual([
      expect.objectContaining({ code: "extension.contribution.undeclared" })
    ]);
  });

  it("removes disposed registrations from the active contribution set", () => {
    const audit = createKineWeaveExtensionContributionAudit(
      context({
        ...manifest,
        contributes: {
          operationTypes: [{ operationType, schemaVersions: [1] }]
        }
      })
    );
    const dispose = audit.context.transactions.registerOperationHandler({
      operationType,
      schemaVersion: 1,
      prepare: () => ({})
    });
    expect(audit.diagnostics()).toEqual([]);
    dispose();
    expect(audit.diagnostics()).toEqual([
      expect.objectContaining({ code: "extension.contribution.missing" })
    ]);
  });
});
