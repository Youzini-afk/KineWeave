const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

import type { LoadedProjectBundle } from "@kineweave/project-format";
import type {
  OpenedStudioProject,
  SavedStudioProject,
  StudioCommand,
  StudioHostApi,
  StudioHostResult,
  StudioOutputJob
} from "./bridge.js";

const channels = {
  chooseProject: "studio.project.choose",
  openProject: "studio.project.open",
  saveProject: "studio.project.save",
  closeProject: "studio.project.close",
  startOutput: "studio.output.start",
  getOutput: "studio.output.get",
  cancelOutput: "studio.output.cancel",
  openOutput: "studio.output.open",
  initialProject: "studio.project.initial",
  command: "studio.command",
  closeResponse: "studio.window.close-response"
} satisfies typeof import("./bridge.js").STUDIO_IPC_CHANNELS;

const api: StudioHostApi = {
  hostKind: "desktop",
  outputFormats: ["svg-sequence", "png-sequence", "mp4", "webm"],
  chooseProject: () => ipcRenderer.invoke(channels.chooseProject) as Promise<string | undefined>,
  openProject: (projectLocator) =>
    ipcRenderer.invoke(channels.openProject, projectLocator) as Promise<
      StudioHostResult<OpenedStudioProject>
    >,
  saveProject: (hostSessionId, bundle: LoadedProjectBundle) =>
    ipcRenderer.invoke(channels.saveProject, hostSessionId, bundle) as Promise<
      StudioHostResult<SavedStudioProject>
    >,
  closeProject: (hostSessionId) =>
    ipcRenderer.invoke(channels.closeProject, hostSessionId) as Promise<void>,
  startOutput: (hostSessionId, request) =>
    ipcRenderer.invoke(channels.startOutput, hostSessionId, request) as ReturnType<
      StudioHostApi["startOutput"]
    >,
  getOutput: (hostSessionId, jobId) =>
    ipcRenderer.invoke(channels.getOutput, hostSessionId, jobId) as Promise<
      StudioHostResult<StudioOutputJob>
    >,
  cancelOutput: (hostSessionId, jobId) =>
    ipcRenderer.invoke(channels.cancelOutput, hostSessionId, jobId) as Promise<
      StudioHostResult<StudioOutputJob>
    >,
  openOutput: (hostSessionId, jobId) =>
    ipcRenderer.invoke(channels.openOutput, hostSessionId, jobId) as ReturnType<
      StudioHostApi["openOutput"]
    >,
  respondToClose: (shouldClose) => {
    ipcRenderer.send(channels.closeResponse, shouldClose);
  },
  onInitialProject(listener) {
    const handler = (_event: Electron.IpcRendererEvent, projectLocator: string) =>
      listener(projectLocator);
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
