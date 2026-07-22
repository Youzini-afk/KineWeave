import { HistoryGraph } from "@kineweave/history-engine";
import type { LoadedProjectBundle } from "@kineweave/project-format";
import {
  CANVAS2D_RENDERER_PROVIDER_ID,
  canvas2dRendererDescriptor
} from "@kineweave/canvas2d-renderer";
import {
  KINEWEAVE_PROTOCOL_VERSION,
  LOCKFILE_FORMAT_VERSION,
  PROJECT_FORMAT_VERSION,
  type JsonObject
} from "@kineweave/protocol";
import {
  INTERACTIVE_RENDERER_CAPABILITY_ID,
  OUTPUT_RENDERER_CAPABILITY_ID
} from "@kineweave/render-engine";
import {
  createStandardComposition,
  STANDARD_COMPOSITION_SCHEMA_VERSION,
  STANDARD_COMPOSITION_TYPE
} from "@kineweave/standard-motion-document";
import {
  SVG_RENDERER_PROVIDER_ID,
  SVG_OUTPUT_TARGET,
  svgRendererDescriptor
} from "@kineweave/svg-renderer";

export interface OfficialProjectTemplateOptions {
  readonly name: string;
  readonly projectId: string;
}

export function createOfficialProjectTemplate(
  options: OfficialProjectTemplateOptions
): LoadedProjectBundle {
  const document = createStandardComposition("document_main", "Main Composition");
  const history = new HistoryGraph({
    [document.documentId]: document as unknown as JsonObject
  });
  return {
    manifest: {
      projectFormatVersion: PROJECT_FORMAT_VERSION,
      projectId: options.projectId,
      name: options.name,
      entryDocumentId: document.documentId,
      documents: {
        [document.documentId]: {
          documentType: STANDARD_COMPOSITION_TYPE,
          schemaVersion: STANDARD_COMPOSITION_SCHEMA_VERSION,
          path: "documents/main.composition.json"
        }
      },
      extensionRequirements: {
        "org.kineweave.standard-motion": {
          versionRange: "^0.1.0",
          source: {
            kind: "package",
            packageName: "@kineweave/standard-motion-document"
          }
        },
        "org.kineweave.svg-renderer": {
          versionRange: "^0.1.0",
          source: {
            kind: "package",
            packageName: "@kineweave/svg-renderer"
          }
        },
        "org.kineweave.canvas2d-renderer": {
          versionRange: "^0.1.0",
          source: {
            kind: "package",
            packageName: "@kineweave/canvas2d-renderer"
          }
        }
      },
      capabilityRequirements: {
        [OUTPUT_RENDERER_CAPABILITY_ID]: {
          contractVersion: "^1.0.0",
          requiredFeatures: [...svgRendererDescriptor.features],
          preferredProvider: SVG_RENDERER_PROVIDER_ID
        },
        [INTERACTIVE_RENDERER_CAPABILITY_ID]: {
          contractVersion: "^1.0.0",
          requiredFeatures: [...canvas2dRendererDescriptor.features],
          preferredProvider: CANVAS2D_RENDERER_PROVIDER_ID
        }
      },
      outputProfiles: {
        svg: {
          target: SVG_OUTPUT_TARGET,
          requiredFeatures: [...svgRendererDescriptor.features],
          settings: {}
        }
      }
    },
    lockfile: {
      lockfileFormatVersion: LOCKFILE_FORMAT_VERSION,
      projectId: options.projectId,
      protocolVersion: KINEWEAVE_PROTOCOL_VERSION,
      extensions: {
        "org.kineweave.standard-motion": {
          version: "0.1.0",
          source: {
            kind: "package",
            packageName: "@kineweave/standard-motion-document"
          }
        },
        "org.kineweave.svg-renderer": {
          version: "0.1.0",
          source: {
            kind: "package",
            packageName: "@kineweave/svg-renderer"
          }
        },
        "org.kineweave.canvas2d-renderer": {
          version: "0.1.0",
          source: {
            kind: "package",
            packageName: "@kineweave/canvas2d-renderer"
          }
        }
      },
      capabilityBindings: {
        [OUTPUT_RENDERER_CAPABILITY_ID]: {
          defaultProviderId: SVG_RENDERER_PROVIDER_ID,
          providers: {
            [SVG_RENDERER_PROVIDER_ID]: {
              providerId: SVG_RENDERER_PROVIDER_ID,
              contractVersion: svgRendererDescriptor.contractVersion,
              implementationVersion: svgRendererDescriptor.implementationVersion,
              features: [...svgRendererDescriptor.features]
            }
          }
        },
        [INTERACTIVE_RENDERER_CAPABILITY_ID]: {
          defaultProviderId: CANVAS2D_RENDERER_PROVIDER_ID,
          providers: {
            [CANVAS2D_RENDERER_PROVIDER_ID]: {
              providerId: CANVAS2D_RENDERER_PROVIDER_ID,
              contractVersion: canvas2dRendererDescriptor.contractVersion,
              implementationVersion:
                canvas2dRendererDescriptor.implementationVersion,
              features: [...canvas2dRendererDescriptor.features]
            }
          }
        }
      },
      resources: {}
    },
    history: history.toSnapshot(),
    documents: { [document.documentId]: document }
  };
}
