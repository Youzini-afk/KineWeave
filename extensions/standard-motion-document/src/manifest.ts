import {
  PRESENTATION_GRAPH_VERSION,
  type ExtensionManifest
} from "@kineweave/protocol";
import {
  STANDARD_COMPOSITION_SCHEMA_VERSION,
  STANDARD_COMPOSITION_TYPE
} from "./model.js";
import { STANDARD_MOTION_OPERATIONS } from "./operations.js";

export const standardMotionExtensionManifest: ExtensionManifest = {
  manifestVersion: 1,
  extensionId: "org.kineweave.standard-motion",
  version: "0.1.0",
  kineweaveVersion: "^0.1.0",
  apiStability: "experimental",
  dependencies: {},
  entrypoints: [
    {
      runtime: "in-process",
      module: "./dist/index.js",
      exportName: "activateStandardMotionExtension",
      hostKinds: ["desktop", "web", "cli", "render-node"]
    }
  ],
  contributes: {
    documentTypes: [
      {
        documentType: STANDARD_COMPOSITION_TYPE,
        schemaVersions: [STANDARD_COMPOSITION_SCHEMA_VERSION]
      }
    ],
    documentEvaluators: [
      {
        documentType: STANDARD_COMPOSITION_TYPE,
        schemaVersions: [STANDARD_COMPOSITION_SCHEMA_VERSION],
        presentationGraphVersions: [PRESENTATION_GRAPH_VERSION]
      }
    ],
    operationTypes: Object.values(STANDARD_MOTION_OPERATIONS).map(
      (operationType) => ({ operationType, schemaVersions: [1] })
    )
  }
};
