import { createOfficialProjectTemplate } from "@kineweave/official-distribution";
import type { LoadedProjectBundle } from "@kineweave/project-format";
import { describe, expect, it } from "vitest";
import type {
  OpenedStudioProject,
  SavedStudioProject,
  StudioHostApi,
  StudioHostResult
} from "../bridge.js";
import { StudioProject } from "./studio-project.js";

function cloneBundle(bundle: LoadedProjectBundle): LoadedProjectBundle {
  return structuredClone(bundle);
}

function createHost(bundle: LoadedProjectBundle): {
  readonly host: StudioHostApi;
  readonly closedSessions: string[];
  savedBundle(): LoadedProjectBundle | undefined;
} {
  const closedSessions: string[] = [];
  let persisted = cloneBundle(bundle);
  let saved: LoadedProjectBundle | undefined;
  const success = <T>(value: T): StudioHostResult<T> => ({ ok: true, value });
  const host: StudioHostApi = {
    chooseProjectDirectory: async () => undefined,
    openProject: async (rootPath): Promise<StudioHostResult<OpenedStudioProject>> =>
      success({
        hostSessionId: "host_session",
        rootPath,
        bundle: cloneBundle(persisted),
        diagnostics: []
      }),
    saveProject: async (hostSessionId, next): Promise<StudioHostResult<SavedStudioProject>> => {
      expect(hostSessionId).toBe("host_session");
      persisted = cloneBundle(next);
      saved = cloneBundle(next);
      return success({ bundle: cloneBundle(persisted) });
    },
    closeProject: async (hostSessionId) => {
      closedSessions.push(hostSessionId);
    },
    respondToClose: () => {},
    onInitialProject: () => () => {},
    onCommand: () => () => {}
  };
  return { host, closedSessions, savedBundle: () => saved };
}

describe("StudioProject", () => {
  it("owns one runtime session across editing, history, evaluation and save", async () => {
    const fixture = createOfficialProjectTemplate({
      name: "Studio integration",
      projectId: "project_studio_integration"
    });
    const harness = createHost(fixture);
    const project = await StudioProject.open("C:/projects/studio", harness.host);
    const originalName = project.document().data.nodes.node_panel!.name;

    expect(project.name).toBe("Studio integration");
    expect(project.canUndo()).toBe(false);

    await project.setNodeAttributes("node_panel", { name: "Renamed panel" });
    await project.setProperty("node_panel", "position", [640, 360]);

    expect(project.document().data.nodes.node_panel!.name).toBe("Renamed panel");
    expect(project.canUndo()).toBe(true);
    expect(project.historyEntries().map((entry) => entry.operationTypes[0])).toEqual([
      "org.kineweave.standard-motion/set-property",
      "org.kineweave.standard-motion/set-node-attributes"
    ]);

    expect(project.undo()).toBe(true);
    expect(project.undo()).toBe(true);
    expect(project.document().data.nodes.node_panel!.name).toBe(originalName);
    expect(project.canRedo()).toBe(true);
    expect(project.redo()).toBe(true);
    expect(project.document().data.nodes.node_panel!.name).toBe("Renamed panel");

    const evaluation = await project.evaluate(1.25, {
      width: 1280,
      height: 720,
      pixelRatio: 1.5
    });
    expect(evaluation.graph.documentId).toBe(project.documentId);
    expect(evaluation.graph.nodes.node_panel).toBeDefined();

    await project.save();
    expect(harness.savedBundle()?.history.branches.main).toBe(
      project.session.history.getBranchHead("main")
    );

    await project.dispose();
    await project.dispose();
    expect(harness.closedSessions).toEqual(["host_session"]);
  });
});
