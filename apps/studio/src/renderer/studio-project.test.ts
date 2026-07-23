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

  it("authors tracks at the playhead and commits multi-property gestures atomically", async () => {
    const fixture = createOfficialProjectTemplate({
      name: "Studio motion authoring",
      projectId: "project_studio_motion_authoring"
    });
    const harness = createHost(fixture);
    const project = await StudioProject.open("C:/projects/motion", harness.host);

    await project.toggleKeyframe("node_headline", "position", [960, 620], 0);
    const positionBinding = project.document().data.nodes.node_headline!.properties.position!;
    expect(positionBinding.kind).toBe("track");
    const trackId = String(positionBinding.trackId);

    await project.setPropertiesAtTime(
      [
        { nodeId: "node_headline", property: "position", value: [1240, 620] },
        { nodeId: "node_headline", property: "rotation", value: 15 }
      ],
      2
    );

    const document = project.document();
    expect(Object.values(document.data.tracks[trackId]!.keyframes)).toHaveLength(2);
    expect(document.data.nodes.node_headline!.properties.rotation).toEqual({
      kind: "constant",
      value: 15
    });
    const head = project.session.history.getBranchHead("main");
    expect(project.session.history.getCommit(head)?.transaction.operations).toHaveLength(2);

    const endKeyframe = Object.values(document.data.tracks[trackId]!.keyframes).find(
      (keyframe) => keyframe.time.value.numerator === "2"
    );
    expect(endKeyframe).toBeDefined();
    await project.moveKeyframe(trackId, endKeyframe!.keyframeId, 3);
    expect(
      project.document().data.tracks[trackId]!.keyframes[endKeyframe!.keyframeId]!.time.value
    ).toEqual({ numerator: "3", denominator: "1" });

    await project.deleteKeyframe(trackId, endKeyframe!.keyframeId, [960, 620]);
    await project.deleteKeyframe(
      trackId,
      Object.keys(project.document().data.tracks[trackId]!.keyframes)[0]!,
      [1040, 620]
    );
    expect(project.document().data.tracks[trackId]).toBeUndefined();
    expect(project.document().data.nodes.node_headline!.properties.position).toEqual({
      kind: "constant",
      value: [1040, 620]
    });

    await project.dispose();
  });
});
