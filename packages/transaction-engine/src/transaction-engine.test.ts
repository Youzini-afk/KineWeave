import { hashJson } from "@kineweave/content-hash";
import { HistoryGraph } from "@kineweave/history-engine";
import type { JsonObject, ProjectDocumentEnvelope, TransactionProposal } from "@kineweave/protocol";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_PRECONDITIONS,
  TransactionEngine,
  TransactionRejectedError
} from "./transaction-engine.js";

const DOCUMENT_TYPE = "org.example.counter/document";
const OPERATION_TYPE = "org.example.counter/increment";

function counterDocument(count: number): ProjectDocumentEnvelope<JsonObject> {
  return {
    documentId: "document_main",
    documentType: DOCUMENT_TYPE,
    schemaVersion: 1,
    data: { count }
  };
}

function proposal(
  amount: number,
  options: {
    transactionId?: string;
    branchName?: string;
    preconditions?: TransactionProposal["operations"][number]["preconditions"];
  } = {}
): TransactionProposal {
  return {
    transactionId: options.transactionId ?? "transaction_increment",
    branchName: options.branchName ?? "main",
    origin: { kind: "user", actorId: "user_local" },
    operations: [
      {
        operationId: `operation_${options.transactionId ?? "increment"}`,
        operationType: OPERATION_TYPE,
        schemaVersion: 1,
        targets: ["kw://project/document/document_main"],
        payload: { documentId: "document_main", amount },
        ...(options.preconditions === undefined ? {} : { preconditions: options.preconditions })
      }
    ]
  };
}

function engine() {
  const history = new HistoryGraph({
    document_main: counterDocument(0) as unknown as JsonObject
  });
  let commitNumber = 0;
  const transactionEngine = new TransactionEngine({
    history,
    host: {
      createCommitId: () => `commit_${++commitNumber}`,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    }
  });
  transactionEngine.registerOperationHandler({
    operationType: OPERATION_TYPE,
    schemaVersion: 1,
    prepare(operation, context) {
      const payload = operation.payload as JsonObject;
      const documentId = payload.documentId as string;
      const amount = payload.amount as number;
      const document = context.readDocument(documentId)!;
      return {
        mutations: [
          {
            kind: "replace" as const,
            documentId,
            document: {
              ...document,
              data: {
                ...document.data,
                count: (document.data.count as number) + amount
              }
            }
          }
        ]
      };
    }
  });
  transactionEngine.registerDocumentValidator({
    documentType: DOCUMENT_TYPE,
    schemaVersion: 1,
    validate(document) {
      return typeof document.data.count === "number" && document.data.count >= 0
        ? []
        : [
            {
              severity: "error" as const,
              code: "counter.count.invalid",
              message: "Counter must be a non-negative number",
              documentId: document.documentId
            }
          ];
    }
  });
  return { history, transactionEngine };
}

describe("TransactionEngine", () => {
  it("prepares, validates and commits patches to the history graph", async () => {
    const { history, transactionEngine } = engine();
    const result = await transactionEngine.execute(proposal(2));

    expect(result.commit.parentCommitIds).toEqual(["commit_root"]);
    expect(result.commit.patches).toHaveLength(1);
    expect(history.stateOfBranch("main")).toEqual({
      document_main: counterDocument(2)
    });
    expect(result.commit.metadata).toMatchObject({
      readDocumentIds: ["document_main"],
      changedDocumentIds: ["document_main"]
    });
  });

  it("validates a complete materialized state without creating a commit", async () => {
    const { history, transactionEngine } = engine();
    const diagnostics = await transactionEngine.validateState({
      document_main: counterDocument(-1) as unknown as JsonObject
    });

    expect(diagnostics).toEqual([expect.objectContaining({ code: "counter.count.invalid" })]);
    expect(history.getBranchHead("main")).toBe("commit_root");
  });

  it("rejects validation failures without moving the branch", async () => {
    const { history, transactionEngine } = engine();
    await expect(transactionEngine.execute(proposal(-1))).rejects.toMatchObject({
      diagnostics: [expect.objectContaining({ code: "counter.count.invalid" })]
    });
    expect(history.getBranchHead("main")).toBe("commit_root");
    expect(history.stateOfBranch("main")).toEqual({
      document_main: counterDocument(0)
    });
  });

  it("checks content-hash preconditions against the transaction draft", async () => {
    const { history, transactionEngine } = engine();
    const wrongHash = hashJson(counterDocument(99) as unknown as JsonObject);
    await expect(
      transactionEngine.execute(
        proposal(1, {
          preconditions: [
            {
              type: BUILTIN_PRECONDITIONS.documentHash,
              schemaVersion: 1,
              payload: {
                documentId: "document_main",
                expectedHash: wrongHash
              }
            }
          ]
        })
      )
    ).rejects.toBeInstanceOf(TransactionRejectedError);
    expect(history.getBranchHead("main")).toBe("commit_root");
  });

  it("does not leak earlier operation changes when a later operation fails", async () => {
    const { history, transactionEngine } = engine();
    transactionEngine.registerOperationHandler({
      operationType: "org.example.counter/fail",
      schemaVersion: 1,
      prepare() {
        throw new Error("intentional failure");
      }
    });
    const value = proposal(1);
    const twoOperations: TransactionProposal = {
      ...value,
      transactionId: "transaction_atomic",
      operations: [
        ...value.operations,
        {
          operationId: "operation_fail",
          operationType: "org.example.counter/fail",
          schemaVersion: 1,
          targets: ["kw://project/document/document_main"],
          payload: null
        }
      ]
    };

    await expect(transactionEngine.execute(twoOperations)).rejects.toThrow(/operation_fail/i);
    expect(history.stateOfBranch("main")).toEqual({
      document_main: counterDocument(0)
    });
  });

  it("uses ordinary branches for isolated AI proposals", async () => {
    const { history, transactionEngine } = engine();
    history.createBranch("proposal/ai");
    await transactionEngine.execute(
      proposal(7, {
        transactionId: "transaction_ai",
        branchName: "proposal/ai"
      })
    );

    expect(history.stateOfBranch("main")).toEqual({
      document_main: counterDocument(0)
    });
    expect(history.stateOfBranch("proposal/ai")).toEqual({
      document_main: counterDocument(7)
    });
  });
});
