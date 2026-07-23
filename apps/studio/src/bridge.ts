import type { LoadedProjectBundle } from "@kineweave/project-format";
import type { Diagnostic } from "@kineweave/protocol";

export const STUDIO_IPC_CHANNELS = {
  chooseProject: "studio.project.choose",
  openProject: "studio.project.open",
  saveProject: "studio.project.save",
  closeProject: "studio.project.close",
  initialProject: "studio.project.initial",
  command: "studio.command",
  closeResponse: "studio.window.close-response"
} as const;

export type StudioCommand =
  | "open-project"
  | "save-project"
  | "undo"
  | "redo"
  | "toggle-playback"
  | "prepare-close";

export interface StudioHostFailure {
  readonly message: string;
  readonly diagnostics: readonly Diagnostic[];
}

export type StudioHostResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: StudioHostFailure };

export interface OpenedStudioProject {
  readonly hostSessionId: string;
  readonly rootPath: string;
  readonly bundle: LoadedProjectBundle;
  readonly diagnostics: readonly Diagnostic[];
}

export interface SavedStudioProject {
  readonly bundle: LoadedProjectBundle;
}

export interface StudioHostApi {
  chooseProjectDirectory(): Promise<string | undefined>;
  openProject(rootPath: string): Promise<StudioHostResult<OpenedStudioProject>>;
  saveProject(
    hostSessionId: string,
    bundle: LoadedProjectBundle
  ): Promise<StudioHostResult<SavedStudioProject>>;
  closeProject(hostSessionId: string): Promise<void>;
  respondToClose(shouldClose: boolean): void;
  onInitialProject(listener: (rootPath: string) => void): () => void;
  onCommand(listener: (command: StudioCommand) => void): () => void;
}
