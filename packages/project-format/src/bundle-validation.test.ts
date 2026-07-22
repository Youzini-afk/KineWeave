import { describe, expect, it } from "vitest";
import {
  KINEWEAVE_PROTOCOL_VERSION,
  type JsonObject
} from "@kineweave/protocol";
import { validateProjectBundle } from "./bundle-validation.js";

function validBundle() {
  const document = {
    documentId: "document_main",
    documentType: "org.kineweave.standard-motion/composition",
    schemaVersion: 1,
    data: {
      unknownNode: {
        type: "org.example.future/fluid",
        payload: { viscosity: 0.72 }
      }
    },
    futureEnvelopeField: [1, 2, 3]
  };
  return {
    manifest: {
      projectFormatVersion: 1,
      projectId: "project_demo",
      name: "Demo",
      entryDocumentId: "document_main",
      documents: {
        document_main: {
          documentType: "org.kineweave.standard-motion/composition",
          schemaVersion: 1,
          path: "documents/main.composition.json",
          futureDescriptorField: { preserved: true }
        }
      },
      extensionRequirements: {
        "org.kineweave.standard-motion": {
          versionRange: "^0.1.0",
          futureRequirementField: true
        }
      },
      capabilityRequirements: {},
      outputProfiles: {},
      futureManifestField: "preserved"
    },
    lockfile: {
      lockfileFormatVersion: 1,
      projectId: "project_demo",
      protocolVersion: KINEWEAVE_PROTOCOL_VERSION,
      extensions: {
        "org.kineweave.standard-motion": {
          version: "0.1.0",
          source: { kind: "package", packageName: "standard-motion" }
        }
      },
      capabilityBindings: {},
      resources: {}
    },
    history: {
      historyFormatVersion: 1,
      rootCommitId: "commit_root",
      mainBranchName: "main",
      rootDocuments: { document_main: structuredClone(document) },
      commits: {},
      branches: { main: "commit_root" },
      futureHistoryField: "preserved"
    },
    documents: {
      document_main: document
    }
  } satisfies {
    manifest: JsonObject;
    lockfile: JsonObject;
    history: JsonObject;
    documents: Record<string, JsonObject>;
  };
}

describe("project bundle validation", () => {
  it("accepts a structurally consistent open-world bundle without mutating it", () => {
    const bundle = validBundle();
    const before = structuredClone(bundle);
    expect(validateProjectBundle(bundle)).toEqual([]);
    expect(bundle).toEqual(before);
  });

  it("reports cross-file identity and path conflicts", () => {
    const bundle = validBundle();
    bundle.manifest.documents.document_main.path = "../outside.json";
    bundle.documents.document_main.documentId = "document_other";

    expect(validateProjectBundle(bundle)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "project.document.path-invalid" }),
        expect.objectContaining({ code: "project.document.id-mismatch" })
      ])
    );
  });
});
