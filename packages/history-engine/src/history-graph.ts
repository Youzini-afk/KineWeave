import { applyDocumentPatch } from "@kineweave/patch";
import {
  HISTORY_FORMAT_VERSION,
  cloneJson,
  type HistoryCommit,
  type JsonValue,
  type KineWeaveHistory
} from "@kineweave/protocol";

export type DocumentState = Readonly<Record<string, JsonValue>>;

export interface BranchRef {
  readonly name: string;
  readonly headCommitId: string;
}

export interface HistoryGraphOptions {
  readonly rootCommitId?: string;
  readonly mainBranchName?: string;
}

function cloneState(state: DocumentState): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(state).map(([documentId, document]) => [
      documentId,
      cloneJson(document)
    ])
  );
}

function validBranchName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9._/-]{0,127}$/.test(name) && !name.includes("//");
}

export class HistoryGraph {
  readonly rootCommitId: string;
  readonly mainBranchName: string;
  readonly #rootState: Record<string, JsonValue>;
  readonly #commits = new Map<string, HistoryCommit>();
  readonly #branches = new Map<string, string>();
  readonly #stateCache = new Map<string, Record<string, JsonValue>>();

  constructor(
    initialDocuments: DocumentState,
    options: HistoryGraphOptions = {}
  ) {
    this.rootCommitId = options.rootCommitId ?? "commit_root";
    this.mainBranchName = options.mainBranchName ?? "main";
    if (!validBranchName(this.mainBranchName)) {
      throw new TypeError(`Invalid main branch name: ${this.mainBranchName}`);
    }
    this.#rootState = cloneState(initialDocuments);
    this.#stateCache.set(this.rootCommitId, cloneState(initialDocuments));
    this.#branches.set(this.mainBranchName, this.rootCommitId);
  }

  static fromSnapshot(snapshot: KineWeaveHistory): HistoryGraph {
    if (snapshot.historyFormatVersion !== HISTORY_FORMAT_VERSION) {
      throw new TypeError(
        `History format ${snapshot.historyFormatVersion} is not the current development format ${HISTORY_FORMAT_VERSION}`
      );
    }
    const history = new HistoryGraph(snapshot.rootDocuments, {
      rootCommitId: snapshot.rootCommitId,
      mainBranchName: snapshot.mainBranchName
    });

    for (const [commitId, commit] of Object.entries(snapshot.commits).sort(
      ([left], [right]) => left.localeCompare(right)
    )) {
      if (commit.commitId !== commitId) {
        throw new Error(
          `History commit key ${commitId} does not match commitId ${commit.commitId}`
        );
      }
      if (commitId === history.rootCommitId) {
        throw new Error(`History contains a commit with root id ${commitId}`);
      }
      if (commit.parentCommitIds.length === 0) {
        throw new Error(`History commit ${commitId} has no parent`);
      }
      const patchedDocuments = new Set<string>();
      for (const patch of commit.patches) {
        if (patchedDocuments.has(patch.documentId)) {
          throw new Error(
            `History commit ${commitId} contains duplicate patch for ${patch.documentId}`
          );
        }
        patchedDocuments.add(patch.documentId);
      }
      history.#commits.set(commitId, structuredClone(commit));
    }

    const visits = new Map<string, "visiting" | "visited">();
    const visit = (commitId: string): void => {
      if (commitId === history.rootCommitId) return;
      const state = visits.get(commitId);
      if (state === "visited") return;
      if (state === "visiting") {
        throw new Error(`History commit graph contains a cycle at ${commitId}`);
      }
      const commit = history.#commits.get(commitId);
      if (commit === undefined) throw new Error(`Unknown history commit ${commitId}`);
      visits.set(commitId, "visiting");
      for (const parentCommitId of commit.parentCommitIds) visit(parentCommitId);
      visits.set(commitId, "visited");
    };
    for (const commitId of [...history.#commits.keys()].sort()) visit(commitId);
    for (const commitId of [...history.#commits.keys()].sort()) {
      history.stateAt(commitId);
    }

    history.#branches.clear();
    for (const [branchName, headCommitId] of Object.entries(snapshot.branches)) {
      if (!validBranchName(branchName)) {
        throw new TypeError(`Invalid branch name: ${branchName}`);
      }
      if (!history.hasCommit(headCommitId)) {
        throw new Error(
          `History branch ${branchName} points to unknown commit ${headCommitId}`
        );
      }
      history.#branches.set(branchName, headCommitId);
    }
    if (!history.#branches.has(history.mainBranchName)) {
      throw new Error(`History is missing main branch ${history.mainBranchName}`);
    }
    return history;
  }

  toSnapshot(): KineWeaveHistory {
    return {
      historyFormatVersion: HISTORY_FORMAT_VERSION,
      rootCommitId: this.rootCommitId,
      mainBranchName: this.mainBranchName,
      rootDocuments: cloneState(this.#rootState),
      commits: Object.fromEntries(
        [...this.#commits.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([commitId, commit]) => [commitId, structuredClone(commit)])
      ),
      branches: Object.fromEntries(
        this.listBranches().map((branch) => [branch.name, branch.headCommitId])
      )
    };
  }

  listBranches(): readonly BranchRef[] {
    return [...this.#branches.entries()]
      .map(([name, headCommitId]) => ({ name, headCommitId }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  getBranchHead(branchName: string): string {
    const head = this.#branches.get(branchName);
    if (head === undefined) throw new Error(`Unknown branch ${branchName}`);
    return head;
  }

  getCommit(commitId: string): HistoryCommit | undefined {
    const commit = this.#commits.get(commitId);
    return commit === undefined ? undefined : structuredClone(commit);
  }

  findCommitByTransactionId(transactionId: string): HistoryCommit | undefined {
    const commit = [...this.#commits.values()].find(
      (candidate) => candidate.transaction.transactionId === transactionId
    );
    return commit === undefined ? undefined : structuredClone(commit);
  }

  hasCommit(commitId: string): boolean {
    return commitId === this.rootCommitId || this.#commits.has(commitId);
  }

  createBranch(
    branchName: string,
    fromCommitId = this.getBranchHead(this.mainBranchName)
  ): BranchRef {
    if (!validBranchName(branchName)) {
      throw new TypeError(`Invalid branch name: ${branchName}`);
    }
    if (this.#branches.has(branchName)) {
      throw new Error(`Branch ${branchName} already exists`);
    }
    if (!this.hasCommit(fromCommitId)) {
      throw new Error(`Unknown commit ${fromCommitId}`);
    }
    this.#branches.set(branchName, fromCommitId);
    return { name: branchName, headCommitId: fromCommitId };
  }

  deleteBranch(branchName: string): void {
    if (branchName === this.mainBranchName) {
      throw new Error("The main branch cannot be deleted");
    }
    if (!this.#branches.delete(branchName)) {
      throw new Error(`Unknown branch ${branchName}`);
    }
  }

  appendCommit(branchName: string, commit: HistoryCommit): void {
    if (commit.commitId === this.rootCommitId || this.#commits.has(commit.commitId)) {
      throw new Error(`Commit ${commit.commitId} already exists`);
    }
    const head = this.getBranchHead(branchName);
    if (commit.parentCommitIds.length === 0) {
      throw new Error("A non-root commit requires at least one parent");
    }
    if (commit.parentCommitIds[0] !== head) {
      throw new Error(
        `Commit ${commit.commitId} is based on ${commit.parentCommitIds[0]}, but ${branchName} points to ${head}`
      );
    }
    for (const parentId of commit.parentCommitIds) {
      if (!this.hasCommit(parentId)) {
        throw new Error(`Unknown parent commit ${parentId}`);
      }
    }
    const patchedDocuments = new Set<string>();
    for (const patch of commit.patches) {
      if (patchedDocuments.has(patch.documentId)) {
        throw new Error(`Commit contains duplicate patch for ${patch.documentId}`);
      }
      patchedDocuments.add(patch.documentId);
    }

    const state = this.#applyCommit(this.stateAt(head), commit);
    this.#commits.set(commit.commitId, structuredClone(commit));
    this.#stateCache.set(commit.commitId, state);
    this.#branches.set(branchName, commit.commitId);
  }

  stateAt(commitId: string): DocumentState {
    const cached = this.#stateCache.get(commitId);
    if (cached !== undefined) return cloneState(cached);
    if (commitId === this.rootCommitId) return cloneState(this.#rootState);

    const chain: HistoryCommit[] = [];
    let cursor = commitId;
    while (!this.#stateCache.has(cursor)) {
      const commit = this.#commits.get(cursor);
      if (commit === undefined) throw new Error(`Unknown commit ${cursor}`);
      chain.push(commit);
      cursor = commit.parentCommitIds[0]!;
    }

    let state = cloneState(this.#stateCache.get(cursor)!);
    for (const commit of chain.reverse()) {
      state = this.#applyCommit(state, commit);
      this.#stateCache.set(commit.commitId, cloneState(state));
    }
    return cloneState(state);
  }

  stateOfBranch(branchName: string): DocumentState {
    return this.stateAt(this.getBranchHead(branchName));
  }

  undo(branchName: string): BranchRef | undefined {
    const head = this.getBranchHead(branchName);
    if (head === this.rootCommitId) return undefined;
    const commit = this.#commits.get(head)!;
    const nextHead = commit.parentCommitIds[0]!;
    this.#branches.set(branchName, nextHead);
    return { name: branchName, headCommitId: nextHead };
  }

  redoCandidates(branchName: string): readonly string[] {
    const head = this.getBranchHead(branchName);
    return [...this.#commits.values()]
      .filter((commit) => commit.parentCommitIds[0] === head)
      .map((commit) => commit.commitId)
      .sort();
  }

  redo(branchName: string, commitId?: string): BranchRef | undefined {
    const candidates = this.redoCandidates(branchName);
    if (candidates.length === 0) return undefined;
    const selected = commitId ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (selected === undefined) {
      throw new Error(
        `Redo is ambiguous on ${branchName}; choose one of ${candidates.join(", ")}`
      );
    }
    if (!candidates.includes(selected)) {
      throw new Error(`Commit ${selected} is not a redo candidate for ${branchName}`);
    }
    this.#branches.set(branchName, selected);
    return { name: branchName, headCommitId: selected };
  }

  #applyCommit(
    previous: DocumentState,
    commit: HistoryCommit
  ): Record<string, JsonValue> {
    const next = cloneState(previous);
    for (const patch of commit.patches) {
      const current = next[patch.documentId] ?? null;
      const result = applyDocumentPatch(current, patch, "forward");
      if (result === null) delete next[patch.documentId];
      else next[patch.documentId] = result;
    }
    return next;
  }
}
