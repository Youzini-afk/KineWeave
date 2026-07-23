import type { EvaluationExecutionResult } from "@kineweave/evaluation-engine";
import {
  createOfficialDistributionProfile,
  KINEWEAVE_VERSION
} from "@kineweave/official-distribution";
import type { LoadedProjectBundle } from "@kineweave/project-format";
import { ProjectSession } from "@kineweave/project-session";
import {
  createProjectResourceUri,
  type Diagnostic,
  type JsonObject,
  type JsonValue,
  type Operation,
  rational,
  STANDARD_COLOR_SPACES,
  STANDARD_TIME_DOMAINS,
  type TransactionProposal,
  timeValue
} from "@kineweave/protocol";
import {
  constant,
  type MotionNode,
  STANDARD_MOTION_OPERATIONS,
  type StandardCompositionDocument
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
    return this.#execute(STANDARD_MOTION_OPERATIONS.setProperty, {
      documentId: this.documentId,
      nodeId,
      property,
      binding: constant(value)
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
    this.#assertOpen();
    const operation: Operation = {
      operationId: stableUuid("operation"),
      operationType,
      schemaVersion: 1,
      targets: [createProjectResourceUri("document", this.documentId)],
      payload
    };
    const proposal: TransactionProposal = {
      transactionId: stableUuid("transaction"),
      branchName: this.session.history.mainBranchName,
      origin: { kind: "user", actorId: "studio" },
      operations: [operation]
    };
    await this.session.execute(proposal);
  }

  #assertOpen(): void {
    if (this.#disposed) throw new StudioProjectError("Studio project is closed");
  }
}
