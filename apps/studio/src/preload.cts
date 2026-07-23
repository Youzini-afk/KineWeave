const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");
import type { LoadedProjectBundle } from "@kineweave/project-format";
import type {
  OpenedStudioProject,
  SavedStudioProject,
  StudioCommand,
  StudioHostApi,
  StudioHostResult
} from "./bridge.js";

const channels = {
  chooseProject: "studio.project.choose",
  openProject: "studio.project.open",
  saveProject: "studio.project.save",
  closeProject: "studio.project.close",
  initialProject: "studio.project.initial",
  command: "studio.command",
  closeResponse: "studio.window.close-response"
} satisfies typeof import("./bridge.js").STUDIO_IPC_CHANNELS;

const api: StudioHostApi = {
  chooseProjectDirectory: () =>
    ipcRenderer.invoke(channels.chooseProject) as Promise<
      string | undefined
    >,
  openProject: (rootPath) =>
    ipcRenderer.invoke(
      channels.openProject,
      rootPath
    ) as Promise<StudioHostResult<OpenedStudioProject>>,
  saveProject: (hostSessionId, bundle: LoadedProjectBundle) =>
    ipcRenderer.invoke(
      channels.saveProject,
      hostSessionId,
      bundle
    ) as Promise<StudioHostResult<SavedStudioProject>>,
  closeProject: (hostSessionId) =>
    ipcRenderer.invoke(
      channels.closeProject,
      hostSessionId
    ) as Promise<void>,
  respondToClose: (shouldClose) => {
    ipcRenderer.send(channels.closeResponse, shouldClose);
  },
  onInitialProject(listener) {
    const handler = (_event: Electron.IpcRendererEvent, rootPath: string) =>
      listener(rootPath);
    ipcRenderer.on(channels.initialProject, handler);
    return () => ipcRenderer.removeListener(channels.initialProject, handler);
  },
  onCommand(listener) {
    const handler = (_event: Electron.IpcRendererEvent, command: StudioCommand) =>
      listener(command);
    ipcRenderer.on(channels.command, handler);
    return () => ipcRenderer.removeListener(channels.command, handler);
  }
};

contextBridge.exposeInMainWorld("kineweaveHost", api);
