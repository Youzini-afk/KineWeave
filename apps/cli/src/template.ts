import { randomUUID } from "node:crypto";
import { HistoryGraph } from "@kineweave/history-engine";
import {
  KINEWEAVE_PROTOCOL_VERSION,
  LOCKFILE_FORMAT_VERSION,
  PROJECT_FORMAT_VERSION,
  type JsonObject
} from "@kineweave/protocol";
import type { LoadedProjectBundle } from "@kineweave/project-repository-node";
import { PRESENTATION_RENDERER_CAPABILITY_ID } from "@kineweave/render-engine";
import {
  createStandardComposition,
  STANDARD_COMPOSITION_SCHEMA_VERSION,
  STANDARD_COMPOSITION_TYPE
} from "@kineweave/standard-motion-document";
import {
  SVG_RENDERER_PROVIDER_ID,
  svgRendererDescriptor
} from "@kineweave/svg-renderer";

export interface ProjectTemplateOptions {
  readonly name: string;
  readonly projectId?: string;
}

export function createProjectTemplate(
  options: ProjectTemplateOptions
): LoadedProjectBundle {
  const projectId =
    options.projectId ?? `project_${randomUUID().replaceAll("-", "")}`;
  const document = createStandardComposition("document_main", "Main Composition");
  const history = new HistoryGraph({
    [document.documentId]: document as unknown as JsonObject
  });
  return {
    manifest: {
      projectFormatVersion: PROJECT_FORMAT_VERSION,
      projectId,
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
        }
      },
      capabilityRequirements: {
        [PRESENTATION_RENDERER_CAPABILITY_ID]: {
          contractVersion: "^1.0.0",
          requiredFeatures: [...svgRendererDescriptor.features],
          preferredProvider: SVG_RENDERER_PROVIDER_ID
        }
      },
      outputProfiles: {
        svg: {
          target: "org.kineweave.output/svg",
          requiredFeatures: [...svgRendererDescriptor.features],
          settings: {}
        }
      }
    },
    lockfile: {
      lockfileFormatVersion: LOCKFILE_FORMAT_VERSION,
      projectId,
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
        }
      },
      capabilityBindings: {
        [PRESENTATION_RENDERER_CAPABILITY_ID]: {
          defaultProviderId: SVG_RENDERER_PROVIDER_ID,
          providers: {
            [SVG_RENDERER_PROVIDER_ID]: {
              providerId: SVG_RENDERER_PROVIDER_ID,
              contractVersion: svgRendererDescriptor.contractVersion,
              implementationVersion: svgRendererDescriptor.implementationVersion,
              features: [...svgRendererDescriptor.features]
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
