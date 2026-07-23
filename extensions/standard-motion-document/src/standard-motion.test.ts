import { describe, expect, it } from "vitest";
import { EvaluationEngine } from "@kineweave/evaluation-engine";
import { HistoryGraph } from "@kineweave/history-engine";
import type { JsonObject, TransactionProposal } from "@kineweave/protocol";
import { TransactionEngine } from "@kineweave/transaction-engine";
import { activateStandardMotionExtension } from "./activation.js";
import { standardMotionExtensionManifest } from "./manifest.js";
import {
  constant,
  createEllipseNode,
  createGroupNode,
  createPathNode,
  createRectangleNode,
  createStandardComposition,
  createTextNode,
  type StandardCompositionDocument
} from "./model.js";
import { STANDARD_MOTION_OPERATIONS } from "./operations.js";
import { validateStandardComposition } from "./validation.js";

function engine() {
  const document = createStandardComposition();
  const history = new HistoryGraph({
    [document.documentId]: document as unknown as JsonObject
  });
  let sequence = 0;
  const transactionEngine = new TransactionEngine({
    history,
    host: {
      createCommitId: () => `commit_${++sequence}`,
      now: () => new Date("2026-01-01T00:00:00.000Z")
    }
  });
  const evaluationEngine = activate(history, transactionEngine);
  return { history, transactionEngine, evaluationEngine };
}

function activate(history: HistoryGraph, transactionEngine: TransactionEngine) {
  const evaluationEngine = new EvaluationEngine({
    host: {
      resolveState: () => history.stateOfBranch(history.mainBranchName)
    }
  });
  activateStandardMotionExtension({
    manifest: standardMotionExtensionManifest,
    hostKind: "cli",
    transactions: transactionEngine,
    evaluation: evaluationEngine,
    rendering: {
      registerOutputRenderer() {
        return () => {};
      },
      registerInteractiveRenderer() {
        return () => {};
      }
    }
  });
  return evaluationEngine;
}

function proposal(
  operationType: string,
  payload: JsonObject,
  transactionId = "transaction_motion"
): TransactionProposal {
  return {
    transactionId,
    branchName: "main",
    origin: { kind: "user" },
    operations: [
      {
        operationId: `operation_${transactionId}`,
        operationType,
        schemaVersion: 1,
        targets: ["kw://project/document/document_main"],
        payload
      }
    ]
  };
}

describe("Standard Motion Document", () => {
  it("creates a structurally valid open composition", () => {
    expect(validateStandardComposition(createStandardComposition())).toEqual([]);
  });

  it("rejects incomplete constants and invalid standard property values", () => {
    const incomplete = createStandardComposition();
    incomplete.data.nodes.node_headline!.properties.position = {
      kind: "constant"
    } as never;
    expect(validateStandardComposition(incomplete)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "standard-motion.schema.required" })
      ])
    );

    const invalidValue = createStandardComposition();
    invalidValue.data.nodes.node_headline!.properties.fontSize = constant(-1);
    expect(validateStandardComposition(invalidValue)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "standard-motion.binding.constant-value-invalid" })
      ])
    );
  });

  it("rejects tracks that do not bind back to their target property", () => {
    const document = createStandardComposition();
    document.data.tracks.track_orphan = {
      trackId: "track_orphan",
      valueType: "org.kineweave.value/number",
      target: { nodeId: "node_headline", property: "fontSize" },
      keyframes: {
        keyframe_start: {
          keyframeId: "keyframe_start",
          time: document.data.duration,
          value: 96
        }
      }
    };

    expect(validateStandardComposition(document)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "standard-motion.track.target-unbound" })
      ])
    );
  });

  it("rejects known standard values and schema versions that cannot be evaluated", () => {
    const document = createStandardComposition();
    document.data.nodes.node_headline = {
      ...document.data.nodes.node_headline!,
      schemaVersion: 3
    };
    document.data.tracks.track_position = {
      trackId: "track_position",
      valueType: "org.kineweave.value/vector2",
      target: { nodeId: "node_headline", property: "position" },
      keyframes: {
        keyframe_start: {
          keyframeId: "keyframe_start",
          time: {
            value: { numerator: "0", denominator: "1" },
            domain: "org.kineweave.time/seconds"
          },
          value: 42
        }
      }
    };
    document.data.nodes.node_headline!.properties.position = {
      kind: "track",
      trackId: "track_position"
    };

    expect(validateStandardComposition(document)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "standard-motion.node.schema-version-unsupported"
        }),
        expect.objectContaining({ code: "standard-motion.keyframe.value-invalid" })
      ])
    );
  });

  it("inserts and edits nodes through formal operations", async () => {
    const { history, transactionEngine } = engine();
    await transactionEngine.execute(
      proposal(STANDARD_MOTION_OPERATIONS.insertNode, {
        documentId: "document_main",
        parentNodeId: null,
        index: 1,
        node: createTextNode("node_subtitle", "Subtitle")
      })
    );
    await transactionEngine.execute(
      proposal(
        STANDARD_MOTION_OPERATIONS.setProperty,
        {
          documentId: "document_main",
          nodeId: "node_subtitle",
          property: "content",
          binding: constant("Updated subtitle")
        },
        "transaction_set_property"
      )
    );

    const document = history.stateOfBranch("main")
      .document_main as unknown as StandardCompositionDocument;
    expect(document.data.rootNodeIds).toEqual([
      "node_scene",
      "node_subtitle"
    ]);
    expect(document.data.nodes.node_subtitle?.properties.content).toEqual(
      constant("Updated subtitle")
    );
  });

  it("does not commit an incomplete property binding", async () => {
    const { history, transactionEngine } = engine();
    const before = history.getBranchHead("main");

    await expect(
      transactionEngine.execute(
        proposal(STANDARD_MOTION_OPERATIONS.setProperty, {
          documentId: "document_main",
          nodeId: "node_headline",
          property: "position",
          binding: { kind: "constant" }
        })
      )
    ).rejects.toThrow();
    expect(history.getBranchHead("main")).toBe(before);
  });

  it("renames and disables a node through a semantic operation", async () => {
    const { history, transactionEngine } = engine();
    await transactionEngine.execute(
      proposal(STANDARD_MOTION_OPERATIONS.setNodeAttributes, {
        documentId: "document_main",
        nodeId: "node_headline",
        name: "Primary title",
        enabled: false
      })
    );

    const document = history.stateOfBranch("main")
      .document_main as unknown as StandardCompositionDocument;
    expect(document.data.nodes.node_headline).toMatchObject({
      name: "Primary title",
      enabled: false
    });
  });

  it("rejects hierarchy cycles without committing", async () => {
    const { history, transactionEngine } = engine();
    await transactionEngine.execute(
      proposal(STANDARD_MOTION_OPERATIONS.insertNode, {
        documentId: "document_main",
        parentNodeId: null,
        index: 1,
        node: createGroupNode("node_group")
      })
    );
    await transactionEngine.execute(
      proposal(
        STANDARD_MOTION_OPERATIONS.insertNode,
        {
          documentId: "document_main",
          parentNodeId: "node_group",
          index: 0,
          node: createTextNode("node_child", "Child")
        },
        "transaction_insert_child"
      )
    );
    await expect(
      transactionEngine.execute(
        proposal(
          STANDARD_MOTION_OPERATIONS.moveNode,
          {
            documentId: "document_main",
            nodeId: "node_group",
            parentNodeId: "node_child",
            index: 0
          },
          "transaction_cycle"
        )
      )
    ).rejects.toThrow(/subtree/i);
    const document = history.stateOfBranch("main")
      .document_main as unknown as StandardCompositionDocument;
    expect(document.data.rootNodeIds).toEqual(["node_scene", "node_group"]);
    expect(document.data.nodes.node_group?.children).toEqual(["node_child"]);
  });

  it("rejects placing children under a text node", async () => {
    const { history, transactionEngine } = engine();
    const before = history.getBranchHead("main");

    await expect(
      transactionEngine.execute(
        proposal(STANDARD_MOTION_OPERATIONS.insertNode, {
          documentId: "document_main",
          parentNodeId: "node_headline",
          index: 0,
        node: createTextNode("node_child", "Child")
        })
      )
    ).rejects.toThrow(/validation/i);
    expect(history.getBranchHead("main")).toBe(before);
  });

  it("models standard rectangle, ellipse and path nodes without custom packets", () => {
    const document = createStandardComposition();
    const rectangle = createRectangleNode("node_rectangle", 320, 180);
    const ellipse = createEllipseNode("node_ellipse", 160, 100);
    const path = createPathNode("node_path", "M 0 -20 L 20 20 L -20 20 Z");
    document.data.rootNodeIds.push(
      rectangle.nodeId,
      ellipse.nodeId,
      path.nodeId
    );
    document.data.nodes[rectangle.nodeId] = rectangle;
    document.data.nodes[ellipse.nodeId] = ellipse;
    document.data.nodes[path.nodeId] = path;

    expect(validateStandardComposition(document)).toEqual([]);
  });

  it("removes a subtree and tracks targeting it", async () => {
    const { history, transactionEngine } = engine();
    const before = history.stateOfBranch("main")
      .document_main as unknown as StandardCompositionDocument;
    const withTrack = structuredClone(before);
    withTrack.data.tracks.track_headline = {
      trackId: "track_headline",
      valueType: "org.kineweave.value/number",
      target: { nodeId: "node_headline", property: "fontSize" },
      keyframes: {}
    };
    const replacementHistory = new HistoryGraph({
      document_main: withTrack as unknown as JsonObject
    });
    const replacementEngine = new TransactionEngine({
      history: replacementHistory,
      host: {
        createCommitId: () => "commit_remove",
        now: () => new Date("2026-01-01T00:00:00.000Z")
      }
    });
    activate(replacementHistory, replacementEngine);

    await replacementEngine.execute(
      proposal(STANDARD_MOTION_OPERATIONS.removeNode, {
        documentId: "document_main",
        nodeId: "node_headline"
      })
    );
    const after = replacementHistory.stateOfBranch("main")
      .document_main as unknown as StandardCompositionDocument;
    expect(after.data.nodes.node_headline).toBeUndefined();
    expect(after.data.nodes.node_scene?.children).not.toContain("node_headline");
    expect(after.data.tracks).toEqual({});
  });
});
