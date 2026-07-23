import type { EvaluationExecutionResult } from "@kineweave/evaluation-engine";
import {
  createOfficialDistributionProfile,
  KINEWEAVE_VERSION
} from "@kineweave/official-distribution";
import type { LoadedProjectBundle } from "@kineweave/project-format";
import { ProjectSession } from "@kineweave/project-session";
import {
  compareRational,
  createProjectResourceUri,
  type Diagnostic,
  type JsonObject,
  type JsonValue,
  type Operation,
  parseRational,
  rational,
  STANDARD_COLOR_SPACES,
  STANDARD_TIME_DOMAINS,
  type TransactionProposal,
  timeValue
} from "@kineweave/protocol";
import {
  constant,
  expectedStandardPropertyValueType,
  type Keyframe,
  type MotionNode,
  type PropertyTrack,
  STANDARD_MOTION_OPERATIONS,
  type StandardCompositionDocument,
  serializedTime
} from "@kineweave/standard-motion-document";
import type { StudioHostApi } from "../bridge.js";

export class StudioProjectError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(message: string, diagnostics: readonly Diagnostic[] = []) {
    super(message);
    this.name = "StudioProjectError";
    this.diagnostics = diagnostics;
  }
}

function stableUuid(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "_")}`;
}

function timeRational(seconds: number) {
  return rational(Math.round(seconds * 1_000_000), 1_000_000);
}

export interface StudioHistoryEntry {
  readonly commitId: string;
  readonly operationTypes: readonly string[];
  readonly timestamp: string;
  readonly current: boolean;
}

export interface StudioPropertyEdit {
  readonly nodeId: string;
  readonly property: string;
  readonly value: JsonValue;
}

export class StudioProject {
  readonly hostSessionId: string;
  readonly rootPath: string;
  readonly session: ProjectSession;
  readonly #host: StudioHostApi;
  #savedBundle: LoadedProjectBundle;
  #disposed = false;

  private constructor(options: {
    readonly hostSessionId: string;
    readonly rootPath: string;
    readonly bundle: LoadedProjectBundle;
    readonly session: ProjectSession;
    readonly host: StudioHostApi;
  }) {
    this.hostSessionId = options.hostSessionId;
    this.rootPath = options.rootPath;
    this.#savedBundle = options.bundle;
    this.session = options.session;
    this.#host = options.host;
  }

  static async open(rootPath: string, host: StudioHostApi): Promise<StudioProject> {
    const opened = await host.openProject(rootPath);
    if (!opened.ok) {
      throw new StudioProjectError(opened.error.message, opened.error.diagnostics);
    }
    try {
      const runtime = await ProjectSession.open({
        kineweaveVersion: KINEWEAVE_VERSION,
        bundle: opened.value.bundle,
        distribution: createOfficialDistributionProfile(),
        host: {
          hostKind: "desktop",
          supportedRuntimes: ["in-process"],
          environment: {
            operatingSystem: navigator.platform,
            architecture: "chromium"
          },
          now: () => new Date(),
          createCommitId: () => stableUuid("commit")
        }
      });
      if (runtime.session === undefined) {
        throw new StudioProjectError(
          "KineWeave extensions could not activate for this project",
          runtime.diagnostics
        );
      }
      return new StudioProject({
        hostSessionId: opened.value.hostSessionId,
        rootPath: opened.value.rootPath,
        bundle: opened.value.bundle,
        session: runtime.session,
        host
      });
    } catch (caught) {
      try {
        await host.closeProject(opened.value.hostSessionId);
      } catch (closeError) {
        throw new AggregateError(
          [caught, closeError],
          "Project activation failed and its host session could not be closed"
        );
      }
      throw caught;
    }
  }

  get name(): string {
    return this.#savedBundle.manifest.name;
  }

  get documentId(): string {
    return this.#savedBundle.manifest.entryDocumentId;
  }

  document(): StandardCompositionDocument {
    const document = this.session.history.stateOfBranch(this.session.history.mainBranchName)[
      this.documentId
    ];
    if (document === undefined) {
      throw new StudioProjectError(`Entry document ${this.documentId} is missing`);
    }
    return document as unknown as StandardCompositionDocument;
  }

  async evaluate(
    seconds: number,
    viewport: { readonly width: number; readonly height: number; readonly pixelRatio: number }
  ): Promise<EvaluationExecutionResult> {
    const branchName = this.session.history.mainBranchName;
    return this.session.evaluate({
      documentId: this.documentId,
      state: { kind: "branch", branchName },
      time: timeValue(timeRational(seconds), STANDARD_TIME_DOMAINS.seconds),
      mode: "interactive",
      viewport: {
        width: Math.max(1, Math.round(viewport.width)),
        height: Math.max(1, Math.round(viewport.height)),
        pixelRatio: timeRational(Math.max(0.001, viewport.pixelRatio))
      },
      colorSpace: STANDARD_COLOR_SPACES.srgb,
      locale: navigator.language,
      randomSeed: `${this.#savedBundle.manifest.projectId}:${seconds.toFixed(6)}`,
      externalSignals: {}
    });
  }

  setProperty(nodeId: string, property: string, value: JsonValue): Promise<void> {
    return this.setProperties([{ nodeId, property, value }]);
  }

  setProperties(edits: readonly StudioPropertyEdit[]): Promise<void> {
    return this.#executeOperations(
      this.#normalizedEdits(edits).map((edit) => ({
        operationType: STANDARD_MOTION_OPERATIONS.setProperty,
        payload: {
          documentId: this.documentId,
          nodeId: edit.nodeId,
          property: edit.property,
          binding: constant(edit.value)
        }
      })),
      "Set properties"
    );
  }

  setPropertiesAtTime(edits: readonly StudioPropertyEdit[], seconds: number): Promise<void> {
    const document = this.document();
    const time = this.#compositionTime(seconds, document);
    const operations = this.#normalizedEdits(edits).map((edit) => {
      const node = document.data.nodes[edit.nodeId];
      if (node === undefined) throw new StudioProjectError(`Node ${edit.nodeId} is missing`);
      const binding = node.properties[edit.property];
      if (binding?.kind === "signal") {
        throw new StudioProjectError(
          `Property ${edit.nodeId}.${edit.property} is signal-driven and cannot be authored directly`
        );
      }
      if (binding?.kind !== "track") {
        return {
          operationType: STANDARD_MOTION_OPERATIONS.setProperty,
          payload: {
            documentId: this.documentId,
            nodeId: edit.nodeId,
            property: edit.property,
            binding: constant(edit.value)
          }
        };
      }
      const track = document.data.tracks[String(binding.trackId)];
      if (track === undefined) {
        throw new StudioProjectError(`Track ${String(binding.trackId)} is missing`);
      }
      const existing = this.#keyframeAtTime(track, time);
      const keyframe: Keyframe = {
        ...(existing ?? { keyframeId: stableUuid("keyframe") }),
        time,
        value: edit.value
      };
      return {
        operationType: STANDARD_MOTION_OPERATIONS.upsertKeyframe,
        payload: {
          documentId: this.documentId,
          trackId: track.trackId,
          keyframe
        }
      };
    });
    return this.#executeOperations(operations, "Author properties at playhead");
  }

  toggleKeyframe(
    nodeId: string,
    property: string,
    value: JsonValue,
    seconds: number
  ): Promise<void> {
    const document = this.document();
    const node = document.data.nodes[nodeId];
    if (node === undefined) throw new StudioProjectError(`Node ${nodeId} is missing`);
    const binding = node.properties[property];
    if (binding?.kind === "signal") {
      throw new StudioProjectError(
        `Property ${nodeId}.${property} is signal-driven and cannot be keyed directly`
      );
    }
    const time = this.#compositionTime(seconds, document);
    if (binding?.kind === "track") {
      const track = document.data.tracks[String(binding.trackId)];
      if (track === undefined) {
        throw new StudioProjectError(`Track ${String(binding.trackId)} is missing`);
      }
      const existing = this.#keyframeAtTime(track, time);
      if (existing === undefined) {
        return this.#execute(STANDARD_MOTION_OPERATIONS.upsertKeyframe, {
          documentId: this.documentId,
          trackId: track.trackId,
          keyframe: {
            keyframeId: stableUuid("keyframe"),
            time,
            value
          }
        });
      }
      if (Object.keys(track.keyframes).length === 1) {
        return this.#execute(STANDARD_MOTION_OPERATIONS.removeTrack, {
          documentId: this.documentId,
          trackId: track.trackId,
          replacementValue: value
        });
      }
      return this.#execute(STANDARD_MOTION_OPERATIONS.deleteKeyframe, {
        documentId: this.documentId,
        trackId: track.trackId,
        keyframeId: existing.keyframeId
      });
    }
    const valueType = expectedStandardPropertyValueType(node.nodeType, property);
    if (valueType === undefined) {
      throw new StudioProjectError(
        `Property ${nodeId}.${property} has no declared animation value type`
      );
    }
    const trackId = stableUuid("track");
    const keyframeId = stableUuid("keyframe");
    return this.#execute(STANDARD_MOTION_OPERATIONS.createTrack, {
      documentId: this.documentId,
      track: {
        trackId,
        valueType,
        target: { nodeId, property },
        keyframes: {
          [keyframeId]: { keyframeId, time, value }
        }
      }
    });
  }

  moveKeyframe(trackId: string, keyframeId: string, seconds: number): Promise<void> {
    return this.#execute(STANDARD_MOTION_OPERATIONS.moveKeyframe, {
      documentId: this.documentId,
      trackId,
      keyframeId,
      time: this.#compositionTime(seconds, this.document())
    });
  }

  deleteKeyframe(trackId: string, keyframeId: string, replacementValue: JsonValue): Promise<void> {
    const track = this.document().data.tracks[trackId];
    if (track === undefined) throw new StudioProjectError(`Track ${trackId} is missing`);
    return Object.keys(track.keyframes).length === 1
      ? this.#execute(STANDARD_MOTION_OPERATIONS.removeTrack, {
          documentId: this.documentId,
          trackId,
          replacementValue
        })
      : this.#execute(STANDARD_MOTION_OPERATIONS.deleteKeyframe, {
          documentId: this.documentId,
          trackId,
          keyframeId
        });
  }

  setKeyframeEasing(trackId: string, keyframeId: string, easing: JsonObject | null): Promise<void> {
    return this.#execute(STANDARD_MOTION_OPERATIONS.setKeyframeEasing, {
      documentId: this.documentId,
      trackId,
      keyframeId,
      easing
    });
  }

  setDuration(seconds: number): Promise<void> {
    return this.#execute(STANDARD_MOTION_OPERATIONS.setDuration, {
      documentId: this.documentId,
      duration: this.#compositionTime(seconds, this.document(), false)
    });
  }

  setNodeAttributes(
    nodeId: string,
    attributes: { readonly name?: string; readonly enabled?: boolean }
  ): Promise<void> {
    return this.#execute(STANDARD_MOTION_OPERATIONS.setNodeAttributes, {
      documentId: this.documentId,
      nodeId,
      ...attributes
    });
  }

  insertNode(node: MotionNode, parentNodeId: string | null, index: number): Promise<void> {
    return this.#execute(STANDARD_MOTION_OPERATIONS.insertNode, {
      documentId: this.documentId,
      parentNodeId,
      index,
      node
    });
  }

  removeNode(nodeId: string): Promise<void> {
    return this.#execute(STANDARD_MOTION_OPERATIONS.removeNode, {
      documentId: this.documentId,
      nodeId
    });
  }

  moveNode(nodeId: string, parentNodeId: string | null, index: number): Promise<void> {
    return this.#execute(STANDARD_MOTION_OPERATIONS.moveNode, {
      documentId: this.documentId,
      nodeId,
      parentNodeId,
      index
    });
  }

  undo(): boolean {
    return this.session.undo() !== undefined;
  }

  redo(): boolean {
    const candidates = this.session.history.redoCandidates(this.session.history.mainBranchName);
    if (candidates.length === 0) return false;
    this.session.redo(this.session.history.mainBranchName, candidates.at(-1));
    return true;
  }

  canUndo(): boolean {
    return (
      this.session.history.getBranchHead(this.session.history.mainBranchName) !==
      this.session.history.rootCommitId
    );
  }

  canRedo(): boolean {
    return this.session.history.redoCandidates(this.session.history.mainBranchName).length > 0;
  }

  historyEntries(limit = 12): readonly StudioHistoryEntry[] {
    const snapshot = this.session.history.toSnapshot();
    const currentHead = this.session.history.getBranchHead(this.session.history.mainBranchName);
    const result: StudioHistoryEntry[] = [];
    let cursor = currentHead;
    while (cursor !== snapshot.rootCommitId && result.length < limit) {
      const commit = snapshot.commits[cursor];
      if (commit === undefined) break;
      result.push({
        commitId: commit.commitId,
        operationTypes: commit.transaction.operations.map((operation) => operation.operationType),
        timestamp: commit.committedAt,
        current: commit.commitId === currentHead
      });
      cursor = commit.parentCommitIds[0]!;
    }
    return result;
  }

  async save(): Promise<void> {
    this.#assertOpen();
    const bundle = this.session.toBundle();
    const saved = await this.#host.saveProject(this.hostSessionId, bundle);
    if (!saved.ok) {
      throw new StudioProjectError(saved.error.message, saved.error.diagnostics);
    }
    this.#savedBundle = saved.value.bundle;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    const errors: unknown[] = [];
    try {
      await this.session.dispose();
    } catch (caught) {
      errors.push(caught);
    }
    try {
      await this.#host.closeProject(this.hostSessionId);
    } catch (caught) {
      errors.push(caught);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Studio project disposal failed");
    }
  }

  async #execute(operationType: string, payload: JsonObject): Promise<void> {
    return this.#executeOperations([{ operationType, payload }]);
  }

  async #executeOperations(
    inputs: readonly { readonly operationType: string; readonly payload: JsonObject }[],
    intent?: string
  ): Promise<void> {
    this.#assertOpen();
    if (inputs.length === 0) return;
    const operations: Operation[] = inputs.map((input) => ({
      operationId: stableUuid("operation"),
      operationType: input.operationType,
      schemaVersion: 1,
      targets: [createProjectResourceUri("document", this.documentId)],
      payload: input.payload
    }));
    const proposal: TransactionProposal = {
      transactionId: stableUuid("transaction"),
      branchName: this.session.history.mainBranchName,
      origin: { kind: "user", actorId: "studio" },
      ...(intent === undefined ? {} : { intent }),
      operations
    };
    await this.session.execute(proposal);
  }

  #normalizedEdits(edits: readonly StudioPropertyEdit[]): readonly StudioPropertyEdit[] {
    const byProperty = new Map<string, StudioPropertyEdit>();
    for (const edit of edits) {
      byProperty.set(`${edit.nodeId}\u0000${edit.property}`, edit);
    }
    return [...byProperty.values()];
  }

  #compositionTime(seconds: number, document: StandardCompositionDocument, clampToDuration = true) {
    if (document.data.duration.domain !== STANDARD_TIME_DOMAINS.seconds) {
      throw new StudioProjectError(
        `Studio requires a time-domain mapper for ${document.data.duration.domain}`
      );
    }
    if (!Number.isFinite(seconds)) throw new StudioProjectError("Time must be finite");
    const duration =
      Number(document.data.duration.value.numerator) /
      Number(document.data.duration.value.denominator);
    const value = clampToDuration ? Math.min(Math.max(0, seconds), duration) : seconds;
    return serializedTime({
      value: timeRational(value),
      domain: document.data.duration.domain
    });
  }

  #keyframeAtTime(
    track: PropertyTrack,
    time: ReturnType<typeof serializedTime>
  ): Keyframe | undefined {
    return Object.values(track.keyframes).find(
      (keyframe) =>
        keyframe.time.domain === time.domain &&
        compareRational(parseRational(keyframe.time.value), parseRational(time.value)) === 0
    );
  }

  #assertOpen(): void {
    if (this.#disposed) throw new StudioProjectError("Studio project is closed");
  }
}
