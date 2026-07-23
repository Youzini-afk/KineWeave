import type {
  Diagnostic,
  JsonObject,
  JsonValue,
  ResolvedPresentationGraph
} from "@kineweave/protocol";
import {
  constant,
  createEllipseNode,
  createPathNode,
  createRectangleNode,
  createTextNode,
  type MotionNode,
  STANDARD_NODE_TYPES,
  type StandardCompositionDocument
} from "@kineweave/standard-motion-document";
import type { StudioHostApi } from "../bridge.js";
import { StageController } from "./stage-controller.js";
import {
  compositionDurationSeconds,
  constantBindingValue,
  defaultPropertyValue,
  findLayerParent,
  flattenLayerTree,
  resolvedPropertyValue
} from "./studio-model.js";
import {
  type StudioHistoryEntry,
  StudioProject,
  StudioProjectError,
  type StudioPropertyEdit
} from "./studio-project.js";

export type StudioPhase = "welcome" | "opening" | "ready" | "error";
export type StudioStatusKind = "info" | "success" | "warning" | "error";

export interface StudioStatus {
  readonly kind: StudioStatusKind;
  readonly message: string;
}

export interface StudioSnapshot {
  readonly phase: StudioPhase;
  readonly projectName?: string;
  readonly rootPath?: string;
  readonly document?: StandardCompositionDocument;
  readonly presentation?: ResolvedPresentationGraph;
  readonly selectedNodeId?: string;
  readonly playheadSeconds: number;
  readonly durationSeconds: number;
  readonly playing: boolean;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly history: readonly StudioHistoryEntry[];
  readonly diagnostics: readonly Diagnostic[];
  readonly status: StudioStatus;
  readonly panelRevision: number;
}

type Listener = (snapshot: StudioSnapshot) => void;

function diagnosticFromError(error: unknown): readonly Diagnostic[] {
  return error instanceof StudioProjectError
    ? error.diagnostics
    : error !== null &&
        typeof error === "object" &&
        "diagnostics" in error &&
        Array.isArray(error.diagnostics)
      ? (error.diagnostics as Diagnostic[])
      : [];
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function newNodeId(kind: string): string {
  return `node_${kind}_${crypto.randomUUID().replaceAll("-", "_")}`;
}

export class StudioController {
  readonly #host: StudioHostApi;
  readonly #stage: StageController;
  readonly #listeners = new Set<Listener>();
  #project: StudioProject | undefined;
  #document: StandardCompositionDocument | undefined;
  #presentation: ResolvedPresentationGraph | undefined;
  #phase: StudioPhase = "welcome";
  #selectedNodeId: string | undefined;
  #playheadSeconds = 0;
  #durationSeconds = 1;
  #playing = false;
  #dirty = false;
  #saving = false;
  #diagnostics: readonly Diagnostic[] = [];
  #status: StudioStatus = {
    kind: "info",
    message: "Open a KineWeave project to begin."
  };
  #panelRevision = 0;
  #mutationRevision = 0;
  #mutationQueue = Promise.resolve();
  #evaluationRequested = false;
  #evaluationLoop: Promise<void> | undefined;
  #savePromise: Promise<void> | undefined;
  #prepareClosePromise: Promise<void> | undefined;
  #autoSaveTimer: ReturnType<typeof setTimeout> | undefined;
  #playbackFrame: number | undefined;
  #playbackStartedAt = 0;
  #playbackStartedFrom = 0;

  constructor(host: StudioHostApi, canvas: HTMLCanvasElement, selection: SVGPolygonElement) {
    this.#host = host;
    this.#stage = new StageController(canvas, selection, {
      onSelect: (nodeId) => this.selectNode(nodeId),
      movablePosition: (nodeId) => this.#movablePosition(nodeId),
      onMove: (nodeId, position) => this.setProperty(nodeId, "position", [...position]),
      onError: (error) => this.reportError(error)
    });
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    listener(this.snapshot());
    return () => this.#listeners.delete(listener);
  }

  snapshot(): StudioSnapshot {
    return {
      phase: this.#phase,
      ...(this.#project === undefined
        ? {}
        : {
            projectName: this.#project.name,
            rootPath: this.#project.rootPath
          }),
      ...(this.#document === undefined ? {} : { document: this.#document }),
      ...(this.#presentation === undefined ? {} : { presentation: this.#presentation }),
      ...(this.#selectedNodeId === undefined ? {} : { selectedNodeId: this.#selectedNodeId }),
      playheadSeconds: this.#playheadSeconds,
      durationSeconds: this.#durationSeconds,
      playing: this.#playing,
      dirty: this.#dirty,
      saving: this.#saving,
      canUndo: this.#project?.canUndo() ?? false,
      canRedo: this.#project?.canRedo() ?? false,
      history: this.#project?.historyEntries() ?? [],
      diagnostics: this.#diagnostics,
      status: this.#status,
      panelRevision: this.#panelRevision
    };
  }

  async chooseAndOpenProject(): Promise<void> {
    if (this.#prepareClosePromise !== undefined) return;
    const rootPath = await this.#host.chooseProjectDirectory();
    if (rootPath !== undefined) await this.openProject(rootPath);
  }

  async openProject(rootPath: string): Promise<void> {
    if (this.#phase === "opening" || this.#prepareClosePromise !== undefined) return;
    this.pause();
    const previousProject = this.#project;
    let candidate: StudioProject | undefined;
    let stageWasTouched = false;
    this.#phase = "opening";
    this.#status = { kind: "info", message: "Opening project…" };
    this.#diagnostics = [];
    this.#emit();
    try {
      if (previousProject !== undefined && this.#dirty) await this.save();
      candidate = await StudioProject.open(rootPath, this.#host);
      const document = candidate.document();
      const durationSeconds = Math.max(0.001, compositionDurationSeconds(document));
      const selectedNodeId =
        document.data.nodes.node_headline === undefined
          ? flattenLayerTree(document).find(
              (item) => item.node.nodeType !== STANDARD_NODE_TYPES.group
            )?.node.nodeId
          : "node_headline";
      const evaluation = await candidate.evaluate(0, this.#stage.viewport());
      stageWasTouched = true;
      await this.#stage.present(candidate.session, evaluation.graph);

      const project = candidate;
      candidate = undefined;
      this.#project = project;
      this.#document = document;
      this.#presentation = evaluation.graph;
      this.#durationSeconds = durationSeconds;
      this.#playheadSeconds = 0;
      this.#selectedNodeId = selectedNodeId;
      this.#dirty = false;
      this.#saving = false;
      this.#phase = "ready";
      this.#diagnostics = evaluation.diagnostics;
      this.#panelRevision += 1;
      this.#status = {
        kind: "success",
        message: `Opened ${project.name}`
      };
      this.#stage.select(this.#selectedNodeId);
      this.#emit();
      if (previousProject !== undefined) {
        try {
          await previousProject.dispose();
        } catch (error) {
          this.reportError(error);
        }
      }
    } catch (caught) {
      let openError: unknown = caught;
      try {
        await candidate?.dispose();
      } catch (disposeError) {
        openError = new AggregateError(
          [openError, disposeError],
          "Opening the project failed and cleanup was incomplete"
        );
      }
      if (previousProject !== undefined && stageWasTouched) {
        try {
          const restored = await previousProject.evaluate(
            this.#playheadSeconds,
            this.#stage.viewport()
          );
          await this.#stage.present(previousProject.session, restored.graph);
          this.#presentation = restored.graph;
          this.#stage.select(this.#selectedNodeId);
        } catch (restoreError) {
          openError = new AggregateError(
            [openError, restoreError],
            "The new project failed to open and the previous Stage could not be restored"
          );
        }
      }
      this.#phase = previousProject === undefined ? "error" : "ready";
      this.#diagnostics = diagnosticFromError(openError);
      this.#status = { kind: "error", message: messageFromError(openError) };
      this.#emit();
    }
  }

  selectNode(nodeId: string | undefined): void {
    if (nodeId !== undefined && this.#document?.data.nodes[nodeId] === undefined) {
      return;
    }
    if (this.#selectedNodeId === nodeId) return;
    this.#selectedNodeId = nodeId;
    this.#panelRevision += 1;
    this.#stage.select(nodeId);
    this.#emit();
  }

  setPlayhead(seconds: number): void {
    const next = Math.min(Math.max(0, seconds), this.#durationSeconds);
    if (Math.abs(next - this.#playheadSeconds) < 1e-6) return;
    this.#playheadSeconds = next;
    if (this.#playing) {
      this.#playbackStartedAt = performance.now();
      this.#playbackStartedFrom = next;
    }
    this.#emit();
    void this.#requestEvaluation().catch(() => {});
  }

  togglePlayback(): void {
    if (this.#project === undefined) return;
    if (this.#playing) this.pause();
    else this.play();
  }

  play(): void {
    if (this.#playing || this.#project === undefined || this.#prepareClosePromise !== undefined) {
      return;
    }
    this.#playing = true;
    this.#playbackStartedAt = performance.now();
    this.#playbackStartedFrom = this.#playheadSeconds;
    this.#status = { kind: "info", message: "Playing preview" };
    this.#emit();
    const tick = (now: number): void => {
      if (!this.#playing) return;
      const elapsed = (now - this.#playbackStartedAt) / 1000;
      this.#playheadSeconds = (this.#playbackStartedFrom + elapsed) % this.#durationSeconds;
      this.#emit();
      void this.#requestEvaluation().catch(() => {});
      this.#playbackFrame = requestAnimationFrame(tick);
    };
    this.#playbackFrame = requestAnimationFrame(tick);
  }

  pause(): void {
    if (!this.#playing) return;
    this.#playing = false;
    if (this.#playbackFrame !== undefined) {
      cancelAnimationFrame(this.#playbackFrame);
      this.#playbackFrame = undefined;
    }
    this.#status = { kind: "info", message: "Preview paused" };
    this.#emit();
  }

  setProperty(nodeId: string, property: string, value: JsonValue): Promise<void> {
    return this.#mutate(
      () =>
        this.#requiredProject().setPropertiesAtTime(
          [{ nodeId, property, value }],
          this.#playheadSeconds
        ),
      `Updated ${property}`
    );
  }

  setProperties(
    edits: readonly StudioPropertyEdit[],
    message = "Transformed selection"
  ): Promise<void> {
    return this.#mutate(
      () => this.#requiredProject().setPropertiesAtTime(edits, this.#playheadSeconds),
      message
    );
  }

  toggleKeyframe(nodeId: string, property: string): Promise<void> {
    return this.#mutate(async () => {
      await this.#requestEvaluation();
      const node = this.#requiredDocument().data.nodes[nodeId];
      if (node === undefined) throw new StudioProjectError(`Node ${nodeId} is missing`);
      const value =
        resolvedPropertyValue(this.#presentation, node, property) ?? defaultPropertyValue(property);
      await this.#requiredProject().toggleKeyframe(nodeId, property, value, this.#playheadSeconds);
    }, `Toggled ${property} keyframe`);
  }

  moveKeyframe(trackId: string, keyframeId: string, seconds: number): Promise<void> {
    return this.#mutate(
      () => this.#requiredProject().moveKeyframe(trackId, keyframeId, seconds),
      "Moved keyframe"
    );
  }

  deleteKeyframe(trackId: string, keyframeId: string): Promise<void> {
    return this.#mutate(async () => {
      await this.#requestEvaluation();
      const track = this.#requiredDocument().data.tracks[trackId];
      if (track === undefined) throw new StudioProjectError(`Track ${trackId} is missing`);
      const node = this.#requiredDocument().data.nodes[track.target.nodeId];
      if (node === undefined)
        throw new StudioProjectError(`Node ${track.target.nodeId} is missing`);
      const replacement =
        resolvedPropertyValue(this.#presentation, node, track.target.property) ??
        defaultPropertyValue(track.target.property);
      await this.#requiredProject().deleteKeyframe(trackId, keyframeId, replacement);
    }, "Deleted keyframe");
  }

  setKeyframeEasing(trackId: string, keyframeId: string, easing: JsonObject | null): Promise<void> {
    return this.#mutate(
      () => this.#requiredProject().setKeyframeEasing(trackId, keyframeId, easing),
      "Changed keyframe easing"
    );
  }

  setDuration(seconds: number): Promise<void> {
    return this.#mutate(() => this.#requiredProject().setDuration(seconds), "Changed duration");
  }

  renameNode(nodeId: string, name: string): Promise<void> {
    return this.#mutate(
      () => this.#requiredProject().setNodeAttributes(nodeId, { name }),
      "Renamed layer"
    );
  }

  setNodeEnabled(nodeId: string, enabled: boolean): Promise<void> {
    return this.#mutate(
      () => this.#requiredProject().setNodeAttributes(nodeId, { enabled }),
      enabled ? "Enabled layer" : "Disabled layer"
    );
  }

  async addNode(kind: "text" | "rectangle" | "ellipse" | "path"): Promise<void> {
    const document = this.#requiredDocument();
    const nodeId = newNodeId(kind);
    let node: MotionNode;
    if (kind === "text") node = createTextNode(nodeId, "New text");
    else if (kind === "rectangle") node = createRectangleNode(nodeId, 360, 220);
    else if (kind === "ellipse") node = createEllipseNode(nodeId, 260, 260);
    else
      node = createPathNode(
        nodeId,
        "M 0 -90 L 24 -28 L 86 -28 L 36 10 L 54 72 L 0 36 L -54 72 L -36 10 L -86 -28 L -24 -28 Z"
      );
    const selected =
      this.#selectedNodeId === undefined ? undefined : document.data.nodes[this.#selectedNodeId];
    const selectedParent =
      selected === undefined ? undefined : findLayerParent(document, selected.nodeId)?.parentNodeId;
    const defaultRootGroup = document.data.rootNodeIds.find(
      (rootId) => document.data.nodes[rootId]?.nodeType === STANDARD_NODE_TYPES.group
    );
    const parentNodeId =
      selected?.nodeType === STANDARD_NODE_TYPES.group
        ? selected.nodeId
        : (selectedParent ?? defaultRootGroup ?? null);
    const siblings =
      parentNodeId === null
        ? document.data.rootNodeIds
        : (document.data.nodes[parentNodeId]?.children ?? document.data.rootNodeIds);
    node.properties.position = constant([
      document.data.canvas.width / 2,
      document.data.canvas.height / 2
    ]);
    await this.#mutate(
      () => this.#requiredProject().insertNode(node, parentNodeId, siblings.length),
      `Added ${kind}`
    );
    this.selectNode(nodeId);
  }

  async removeSelectedNode(): Promise<void> {
    const nodeId = this.#selectedNodeId;
    if (nodeId === undefined) return;
    const document = this.#requiredDocument();
    const parent = findLayerParent(document, nodeId)?.parentNodeId;
    await this.#mutate(() => this.#requiredProject().removeNode(nodeId), "Removed layer");
    this.selectNode(parent ?? undefined);
  }

  moveSelectedLayer(direction: -1 | 1): Promise<void> {
    const nodeId = this.#selectedNodeId;
    const document = this.#requiredDocument();
    if (nodeId === undefined) return Promise.resolve();
    const location = findLayerParent(document, nodeId);
    if (location === undefined) return Promise.resolve();
    const siblings =
      location.parentNodeId === null
        ? document.data.rootNodeIds
        : document.data.nodes[location.parentNodeId]!.children;
    const nextIndex = Math.min(Math.max(0, location.index + direction), siblings.length - 1);
    if (nextIndex === location.index) return Promise.resolve();
    return this.#mutate(
      () => this.#requiredProject().moveNode(nodeId, location.parentNodeId, nextIndex),
      "Reordered layer"
    );
  }

  undo(): Promise<void> {
    return this.#mutateHistory(() => this.#requiredProject().undo(), "Undo");
  }

  redo(): Promise<void> {
    return this.#mutateHistory(() => this.#requiredProject().redo(), "Redo");
  }

  save(): Promise<void> {
    if (this.#project === undefined) return Promise.resolve();
    if (this.#savePromise !== undefined) return this.#savePromise;
    if (this.#autoSaveTimer !== undefined) {
      clearTimeout(this.#autoSaveTimer);
      this.#autoSaveTimer = undefined;
    }
    const revision = this.#mutationRevision;
    this.#saving = true;
    this.#status = { kind: "info", message: "Saving project…" };
    this.#emit();
    const save = this.#project
      .save()
      .then(() => {
        if (this.#mutationRevision === revision) this.#dirty = false;
        this.#status = { kind: "success", message: "Project saved" };
      })
      .catch((error) => {
        this.#diagnostics = diagnosticFromError(error);
        this.#status = { kind: "error", message: messageFromError(error) };
        throw error;
      })
      .finally(() => {
        this.#saving = false;
        this.#savePromise = undefined;
        this.#emit();
        if (this.#dirty && this.#prepareClosePromise === undefined) {
          this.#scheduleAutoSave();
        }
      });
    this.#savePromise = save;
    return save;
  }

  reportError(error: unknown): void {
    this.#diagnostics = diagnosticFromError(error);
    this.#status = { kind: "error", message: messageFromError(error) };
    this.#emit();
  }

  async dispose(): Promise<void> {
    await this.prepareToClose();
    const failures: unknown[] = [];
    try {
      await this.#stage.dispose();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.#project?.dispose();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Studio cleanup was incomplete");
    }
  }

  prepareToClose(): Promise<void> {
    if (this.#prepareClosePromise !== undefined) return this.#prepareClosePromise;
    this.pause();
    if (this.#autoSaveTimer !== undefined) {
      clearTimeout(this.#autoSaveTimer);
      this.#autoSaveTimer = undefined;
    }
    const preparation = (async () => {
      await this.#mutationQueue;
      await this.#evaluationLoop;
      if (this.#dirty || this.#savePromise !== undefined) await this.save();
    })();
    this.#prepareClosePromise = preparation;
    void preparation.catch(() => {
      if (this.#prepareClosePromise !== preparation) return;
      this.#prepareClosePromise = undefined;
      if (this.#dirty) this.#scheduleAutoSave();
    });
    return preparation;
  }

  #movablePosition(nodeId: string): readonly [number, number] | undefined {
    const binding = this.#document?.data.nodes[nodeId]?.properties.position;
    const value = constantBindingValue(binding);
    return Array.isArray(value) &&
      value.length === 2 &&
      value.every((coordinate) => typeof coordinate === "number")
      ? [value[0] as number, value[1] as number]
      : binding === undefined
        ? [0, 0]
        : undefined;
  }

  #mutate(action: () => Promise<void>, message: string): Promise<void> {
    if (this.#prepareClosePromise !== undefined) {
      return Promise.reject(new StudioProjectError("Studio is preparing to close"));
    }
    const operation = this.#mutationQueue.then(async () => {
      await action();
      this.#afterMutation(message);
      await this.#requestEvaluation();
    });
    this.#mutationQueue = operation.catch((error) => this.reportError(error));
    return operation;
  }

  #mutateHistory(action: () => boolean, message: string): Promise<void> {
    if (this.#prepareClosePromise !== undefined) {
      return Promise.reject(new StudioProjectError("Studio is preparing to close"));
    }
    const operation = this.#mutationQueue.then(async () => {
      if (!action()) {
        this.#status = { kind: "info", message: `Nothing to ${message.toLowerCase()}` };
        this.#emit();
        return;
      }
      this.#afterMutation(message);
      await this.#requestEvaluation();
    });
    this.#mutationQueue = operation.catch((error) => this.reportError(error));
    return operation;
  }

  #afterMutation(message: string): void {
    this.#document = this.#requiredProject().document();
    if (
      this.#selectedNodeId !== undefined &&
      this.#document.data.nodes[this.#selectedNodeId] === undefined
    ) {
      this.#selectedNodeId = undefined;
      this.#stage.select(undefined);
    }
    this.#durationSeconds = Math.max(0.001, compositionDurationSeconds(this.#document));
    this.#playheadSeconds = Math.min(this.#playheadSeconds, this.#durationSeconds);
    this.#mutationRevision += 1;
    this.#panelRevision += 1;
    this.#dirty = true;
    this.#diagnostics = [];
    this.#status = { kind: "success", message };
    this.#emit();
    this.#scheduleAutoSave();
  }

  #scheduleAutoSave(): void {
    if (this.#prepareClosePromise !== undefined) return;
    if (this.#autoSaveTimer !== undefined) clearTimeout(this.#autoSaveTimer);
    this.#autoSaveTimer = setTimeout(() => {
      this.#autoSaveTimer = undefined;
      void this.save().catch(() => {});
    }, 900);
  }

  #requestEvaluation(): Promise<void> {
    this.#evaluationRequested = true;
    if (this.#evaluationLoop !== undefined) return this.#evaluationLoop;
    const loop = (async () => {
      while (this.#evaluationRequested) {
        this.#evaluationRequested = false;
        const project = this.#project;
        if (project === undefined) return;
        const result = await project.evaluate(this.#playheadSeconds, this.#stage.viewport());
        if (project !== this.#project) return;
        this.#diagnostics = result.diagnostics;
        this.#presentation = result.graph;
        await this.#stage.present(project.session, result.graph);
        this.#stage.select(this.#selectedNodeId);
        if (!this.#playing) this.#emit();
      }
    })()
      .catch((error) => {
        this.reportError(error);
        throw error;
      })
      .finally(() => {
        this.#evaluationLoop = undefined;
      });
    this.#evaluationLoop = loop;
    return loop;
  }

  #requiredProject(): StudioProject {
    if (this.#project === undefined) throw new StudioProjectError("No project is open");
    return this.#project;
  }

  #requiredDocument(): StandardCompositionDocument {
    if (this.#document === undefined) {
      throw new StudioProjectError("No composition is open");
    }
    return this.#document;
  }

  #emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }
}
