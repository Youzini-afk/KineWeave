import { createDocumentPatch } from "@kineweave/patch";
import type { HistoryCommit, TransactionProposal } from "@kineweave/protocol";
import { describe, expect, it } from "vitest";
import { HistoryGraph } from "./history-graph.js";

function proposal(transactionId: string, branchName: string): TransactionProposal {
  return {
    transactionId,
    branchName,
    origin: { kind: "user" },
    operations: [
      {
        operationId: `${transactionId}_operation`,
        operationType: "org.example.document/set-value",
        schemaVersion: 1,
        targets: ["kw://project/document/document_main"],
        payload: { value: transactionId }
      }
    ]
  };
}

function commit(
  commitId: string,
  parentCommitId: string,
  branchName: string,
  before: unknown,
  after: unknown
): HistoryCommit {
  return {
    commitId,
    parentCommitIds: [parentCommitId],
    transaction: proposal(`transaction_${commitId}`, branchName),
    committedAt: "2026-01-01T00:00:00.000Z",
    patches: [
      createDocumentPatch(
        "document_main",
        before as import("@kineweave/protocol").JsonValue,
        after as import("@kineweave/protocol").JsonValue
      )
    ],
    diagnostics: []
  };
}

describe("HistoryGraph", () => {
  it("keeps branches independent and reconstructs state from patches", () => {
    const history = new HistoryGraph({ document_main: { value: 0 } });
    history.appendCommit(
      "main",
      commit("commit_1", "commit_root", "main", { value: 0 }, { value: 1 })
    );
    history.createBranch("proposal/ai", "commit_1");
    history.appendCommit(
      "proposal/ai",
      commit("commit_proposal", "commit_1", "proposal/ai", { value: 1 }, { value: 99 })
    );
    history.appendCommit(
      "main",
      commit("commit_2", "commit_1", "main", { value: 1 }, { value: 2 })
    );

    expect(history.stateOfBranch("main")).toEqual({
      document_main: { value: 2 }
    });
    expect(history.stateOfBranch("proposal/ai")).toEqual({
      document_main: { value: 99 }
    });
  });

  it("moves branch refs for undo and supports explicit redo", () => {
    const history = new HistoryGraph({ document_main: { value: 0 } });
    history.appendCommit(
      "main",
      commit("commit_1", "commit_root", "main", { value: 0 }, { value: 1 })
    );
    history.appendCommit(
      "main",
      commit("commit_2", "commit_1", "main", { value: 1 }, { value: 2 })
    );

    expect(history.undo("main")?.headCommitId).toBe("commit_1");
    expect(history.stateOfBranch("main")).toEqual({
      document_main: { value: 1 }
    });
    expect(history.redo("main", "commit_2")?.headCommitId).toBe("commit_2");
  });

  it("does not need the original operation handler to reconstruct state", () => {
    const history = new HistoryGraph({ document_main: { value: 0 } });
    history.appendCommit(
      "main",
      commit("commit_1", "commit_root", "main", { value: 0 }, { value: 1 })
    );
    expect(history.stateAt("commit_1")).toEqual({
      document_main: { value: 1 }
    });
  });

  it("round-trips the commit graph and branch refs through a history snapshot", () => {
    const history = new HistoryGraph({ document_main: { value: 0 } });
    history.appendCommit(
      "main",
      commit("commit_1", "commit_root", "main", { value: 0 }, { value: 1 })
    );
    history.createBranch("proposal/ai", "commit_1");
    history.appendCommit(
      "proposal/ai",
      commit("commit_proposal", "commit_1", "proposal/ai", { value: 1 }, { value: 9 })
    );

    const restored = HistoryGraph.fromSnapshot(history.toSnapshot());
    expect(restored.listBranches()).toEqual(history.listBranches());
    expect(restored.stateOfBranch("main")).toEqual({
      document_main: { value: 1 }
    });
    expect(restored.stateOfBranch("proposal/ai")).toEqual({
      document_main: { value: 9 }
    });
  });

  it("rejects persisted history whose patch hashes do not verify", () => {
    const history = new HistoryGraph({ document_main: { value: 0 } });
    history.appendCommit(
      "main",
      commit("commit_1", "commit_root", "main", { value: 0 }, { value: 1 })
    );
    const validSnapshot = history.toSnapshot();
    const validCommit = validSnapshot.commits.commit_1!;
    const snapshot = {
      ...validSnapshot,
      commits: {
        ...validSnapshot.commits,
        commit_1: {
          ...validCommit,
          patches: [
            {
              ...validCommit.patches[0]!,
              beforeHash: `sha256:${"0".repeat(64)}`
            }
          ]
        }
      }
    };

    expect(() => HistoryGraph.fromSnapshot(snapshot)).toThrow(/base mismatch/i);
  });
});
