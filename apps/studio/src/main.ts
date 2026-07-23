import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  shell,
  type MenuItemConstructorOptions
} from "electron";
import type { LoadedProjectBundle } from "@kineweave/project-format";
import {
  NodeProjectRepository,
  type ProjectSnapshot
} from "@kineweave/project-repository-node";
import type { Diagnostic } from "@kineweave/protocol";
import {
  STUDIO_IPC_CHANNELS,
  type OpenedStudioProject,
  type SavedStudioProject,
  type StudioCommand,
  type StudioHostResult
} from "./bridge.js";

interface HostedProject {
  snapshot: ProjectSnapshot;
  saveQueue: Promise<void>;
}

interface WindowCloseState {
  authorized: boolean;
  pending: boolean;
  rendererReady: boolean;
}

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const repository = new NodeProjectRepository();
const hostedProjects = new Map<string, HostedProject>();
const windowCloseStates = new Map<number, WindowCloseState>();

app.setName("KineWeave Studio");

function diagnostic(
  code: string,
  message: string,
  source = "@kineweave/studio"
): Diagnostic {
  return { severity: "error", code, message, source };
}

function failure<T>(caught: unknown): StudioHostResult<T> {
  const message = caught instanceof Error ? caught.message : String(caught);
  const diagnostics =
    caught !== null &&
    typeof caught === "object" &&
    "diagnostics" in caught &&
    Array.isArray(caught.diagnostics)
      ? (caught.diagnostics as Diagnostic[])
      : [diagnostic("studio.host.failed", message)];
  return { ok: false, error: { message, diagnostics } };
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function registerProjectHandlers(): void {
  ipcMain.on(
    STUDIO_IPC_CHANNELS.closeResponse,
    (event, rawShouldClose: unknown) => {
      if (typeof rawShouldClose !== "boolean") return;
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (owner === null) return;
      const state = windowCloseStates.get(owner.id);
      if (state === undefined || !state.pending) return;
      state.pending = false;
      if (!rawShouldClose) return;
      state.authorized = true;
      owner.close();
    }
  );

  ipcMain.handle(STUDIO_IPC_CHANNELS.chooseProject, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: "Open KineWeave Project",
      buttonLabel: "Open Project",
      properties: ["openDirectory", "createDirectory"]
    };
    const result =
      owner === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(owner, options);
    return result.canceled ? undefined : result.filePaths[0];
  });

  ipcMain.handle(
    STUDIO_IPC_CHANNELS.openProject,
    async (_event, rawRootPath: unknown): Promise<StudioHostResult<OpenedStudioProject>> => {
      try {
        const rootPath = assertString(rawRootPath, "Project path");
        const read = await repository.read(rootPath);
        if (read.snapshot === undefined) {
          return {
            ok: false,
            error: {
              message: "The project could not be opened",
              diagnostics: read.diagnostics
            }
          };
        }
        const hostSessionId = `studio_${randomUUID()}`;
        hostedProjects.set(hostSessionId, {
          snapshot: read.snapshot,
          saveQueue: Promise.resolve()
        });
        return {
          ok: true,
          value: {
            hostSessionId,
            rootPath: read.snapshot.rootPath,
            bundle: read.snapshot.bundle,
            diagnostics: read.diagnostics
          }
        };
      } catch (caught) {
        return failure(caught);
      }
    }
  );

  ipcMain.handle(
    STUDIO_IPC_CHANNELS.saveProject,
    async (
      _event,
      rawHostSessionId: unknown,
      rawBundle: unknown
    ): Promise<StudioHostResult<SavedStudioProject>> => {
      try {
        const hostSessionId = assertString(
          rawHostSessionId,
          "Host project session ID"
        );
        const hosted = hostedProjects.get(hostSessionId);
        if (hosted === undefined) {
          throw new Error(`Unknown Studio project session ${hostSessionId}`);
        }
        if (rawBundle === null || typeof rawBundle !== "object") {
          throw new TypeError("Project bundle must be an object");
        }
        const bundle = rawBundle as LoadedProjectBundle;
        let saved!: ProjectSnapshot;
        const save = hosted.saveQueue.then(async () => {
          saved = await repository.save(hosted.snapshot, bundle);
          hosted.snapshot = saved;
        });
        hosted.saveQueue = save.catch(() => {});
        await save;
        return { ok: true, value: { bundle: saved.bundle } };
      } catch (caught) {
        return failure(caught);
      }
    }
  );

  ipcMain.handle(
    STUDIO_IPC_CHANNELS.closeProject,
    (_event, rawHostSessionId: unknown): void => {
      if (typeof rawHostSessionId === "string") {
        hostedProjects.delete(rawHostSessionId);
      }
    }
  );
}

function sendCommand(command: StudioCommand): void {
  BrowserWindow.getFocusedWindow()?.webContents.send(
    STUDIO_IPC_CHANNELS.command,
    command
  );
}

function installMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "quit" as const }
            ]
          }
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Open Project…",
          accelerator: "CmdOrCtrl+O",
          click: () => sendCommand("open-project")
        },
        {
          label: "Save Project",
          accelerator: "CmdOrCtrl+S",
          click: () => sendCommand("save-project")
        },
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { role: "quit" }
      ]
    },
    {
      label: "Edit",
      submenu: [
        {
          label: "Undo",
          accelerator: "CmdOrCtrl+Z",
          click: () => sendCommand("undo")
        },
        {
          label: "Redo",
          accelerator: "CmdOrCtrl+Shift+Z",
          click: () => sendCommand("redo")
        },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "Playback",
      submenu: [
        {
          label: "Play / Pause",
          accelerator: "Space",
          click: () => sendCommand("toggle-playback")
        }
      ]
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "togglefullscreen" }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function initialProjectArgument(): string | undefined {
  const index = process.argv.indexOf("--project");
  return index === -1 ? undefined : process.argv[index + 1];
}

async function createWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    title: "KineWeave Studio",
    width: 1540,
    height: 980,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#0d0f14",
    show: false,
    webPreferences: {
      preload: path.join(currentDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  const windowId = window.id;
  const closeState: WindowCloseState = {
    authorized: false,
    pending: false,
    rendererReady: false
  };
  windowCloseStates.set(windowId, closeState);
  window.on("close", (event) => {
    if (closeState.authorized || !closeState.rendererReady) return;
    event.preventDefault();
    if (closeState.pending) return;
    closeState.pending = true;
    window.webContents.send(STUDIO_IPC_CHANNELS.command, "prepare-close");
  });
  window.on("closed", () => windowCloseStates.delete(windowId));
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.once("ready-to-show", () => window.show());
  const developmentUrl = process.env.KINEWEAVE_STUDIO_DEV_URL;
  if (developmentUrl === undefined) {
    await window.loadFile(
      path.join(currentDirectory, "..", "dist-renderer", "index.html")
    );
  } else {
    await window.loadURL(developmentUrl);
  }
  closeState.rendererReady = true;
  const initialProject = initialProjectArgument();
  if (initialProject !== undefined) {
    window.webContents.send(STUDIO_IPC_CHANNELS.initialProject, initialProject);
  }
  return window;
}

registerProjectHandlers();

async function launch(): Promise<void> {
  await app.whenReady();
  installMenu();
  await createWindow();
}

void launch().catch((caught: unknown) => {
  const message = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  console.error(message);
  dialog.showErrorBox("KineWeave Studio could not start", message);
  app.exit(1);
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on("window-all-closed", () => {
  hostedProjects.clear();
  if (process.platform !== "darwin") app.quit();
});
