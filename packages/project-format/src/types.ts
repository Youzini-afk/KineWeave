import type {
  JsonObject,
  KineWeaveHistory,
  KineWeaveLockfile,
  KineWeaveProjectManifest,
  ProjectDocumentEnvelope
} from "@kineweave/protocol";

export interface LoadedProjectBundle {
  readonly manifest: KineWeaveProjectManifest;
  readonly lockfile: KineWeaveLockfile;
  readonly history: KineWeaveHistory;
  readonly documents: Readonly<
    Record<string, ProjectDocumentEnvelope<JsonObject>>
  >;
}
