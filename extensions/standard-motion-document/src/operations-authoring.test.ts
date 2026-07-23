import { HistoryGraph } from "@kineweave/history-engine";
import {
  type JsonObject,
  type Operation,
  rational,
  STANDARD_TIME_DOMAINS,
  type TransactionProposal
} from "@kineweave/protocol";
import { TransactionEngine } from "@kineweave/transaction-engine";
import { describe, expect, it } from "vitest";
import { activateStandardMotionExtension } from "./activation.js";
import { standardMotionExtensionManifest } from "./manifest.js";
import {
  constant,
  createStandardComposition,
  cubicBezierEasing,
  STANDARD_KEYFRAME_EASINGS,
  STANDARD_VALUE_TYPES,
  type StandardCompositionDocument,
  serializedTime
} from "./model.js";
import { STANDARD_MOTION_OPERATIONS } from "./operations.js";
import { validateStandardComposition } from "./validation.js";

function seconds(numerator: number, denominator = 1) {
  return serializedTime({
    value: rational(numerator, denominator),
    domain: STANDARD_TIME_DOMAINS.seconds
  });
}

function authoringEngine() {
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
  activateStandardMotionExtension({
    manifest: standardMotionExtensionManifest,
    hostKind: "cli",
    transactions: transactionEngine,
    evaluation: {
      registerDocumentEvaluator() {
        return () => {};
      }
    },
    rendering: {
      registerOutputRenderer() {
        return () => {};
      },
      registerInteractiveRenderer() {
        return () => {};
      }
    }
  });
  return { history, transactionEngine };
}

function operation(operationType: string, payload: JsonObject, suffix: string): Operation {
  return {
    operationId: `operation_${suffix}`,
    operationType,
    schemaVersion: 1,
    targets: ["kw://project/document/document_main"],
    payload
  };
}

function proposal(
  operations: readonly Operation[],
  transactionId = "transaction_authoring"
): TransactionProposal {
  return {
    transactionId,
    branchName: "main",
    origin: { kind: "user" },
    operations
  };
}

function positionTrack() {
  return {
    trackId: "track_headline_position",
    valueType: STANDARD_VALUE_TYPES.vector2,
    target: { nodeId: "node_headline", property: "position" },
    keyframes: {
      keyframe_start: {
        keyframeId: "keyframe_start",
        time: seconds(0),
        value: [960, 620],
        easing: cubicBezierEasing(0.42, 0, 0.58, 1)
      }
    }
  };
}

function documentAtHead(history: HistoryGraph): StandardCompositionDocument {
  return history.stateOfBranch("main").document_main as unknown as StandardCompositionDocument;
}

describe("Standard Motion authoring operations", () => {
  it("creates a track and adds a keyframe in one atomic transaction", async () => {
    const { history, transactionEngine } = authoringEngine();

    await transactionEngine.execute(
      proposal([
        operation(
          STANDARD_MOTION_OPERATIONS.createTrack,
          { documentId: "document_main", track: positionTrack() },
          "create_track"
        ),
        operation(
          STANDARD_MOTION_OPERATIONS.upsertKeyframe,
          {
            documentId: "document_main",
            trackId: "track_headline_position",
            keyframe: {
              keyframeId: "keyframe_end",
              time: seconds(5),
              value: [1320, 620]
            }
          },
          "add_keyframe"
        )
      ])
    );

    const document = documentAtHead(history);
    expect(document.data.nodes.node_headline?.properties.position).toEqual({
      kind: "track",
      trackId: "track_headline_position"
    });
    expect(Object.keys(document.data.tracks.track_headline_position?.keyframes ?? {})).toEqual([
      "keyframe_start",
      "keyframe_end"
    ]);
    expect(history.getCommit(history.getBranchHead("main"))?.transaction.operations).toHaveLength(
      2
    );
    history.undo("main");
    expect(documentAtHead(history).data.tracks).toEqual({});
    expect(documentAtHead(history).data.nodes.node_headline?.properties.position).toEqual(
      constant([960, 620])
    );
  });

  it("moves a keyframe without changing its value or outgoing easing", async () => {
    const { history, transactionEngine } = authoringEngine();
    await transactionEngine.execute(
      proposal([
        operation(
          STANDARD_MOTION_OPERATIONS.createTrack,
          { documentId: "document_main", track: positionTrack() },
          "create_track"
        )
      ])
    );
    await transactionEngine.execute(
      proposal(
        [
          operation(
            STANDARD_MOTION_OPERATIONS.moveKeyframe,
            {
              documentId: "document_main",
              trackId: "track_headline_position",
              keyframeId: "keyframe_start",
              time: seconds(3, 2)
            },
            "move_keyframe"
          )
        ],
        "transaction_move"
      )
    );

    expect(
      documentAtHead(history).data.tracks.track_headline_position?.keyframes.keyframe_start
    ).toEqual({
      keyframeId: "keyframe_start",
      time: seconds(3, 2),
      value: [960, 620],
      easing: cubicBezierEasing(0.42, 0, 0.58, 1)
    });
  });

  it("rejects same-time collisions and leaves history untouched", async () => {
    const { history, transactionEngine } = authoringEngine();
    await transactionEngine.execute(
      proposal([
        operation(
          STANDARD_MOTION_OPERATIONS.createTrack,
          { documentId: "document_main", track: positionTrack() },
          "create_track"
        ),
        operation(
          STANDARD_MOTION_OPERATIONS.upsertKeyframe,
          {
            documentId: "document_main",
            trackId: "track_headline_position",
            keyframe: { keyframeId: "keyframe_end", time: seconds(5), value: [1200, 620] }
          },
          "add_keyframe"
        )
      ])
    );
    const before = history.getBranchHead("main");

    await expect(
      transactionEngine.execute(
        proposal(
          [
            operation(
              STANDARD_MOTION_OPERATIONS.moveKeyframe,
              {
                documentId: "document_main",
                trackId: "track_headline_position",
                keyframeId: "keyframe_end",
                time: seconds(0)
              },
              "collide"
            )
          ],
          "transaction_collision"
        )
      )
    ).rejects.toThrow(/collides/i);
    expect(history.getBranchHead("main")).toBe(before);
  });

  it("requires an explicit track removal instead of deleting the last keyframe", async () => {
    const { history, transactionEngine } = authoringEngine();
    await transactionEngine.execute(
      proposal([
        operation(
          STANDARD_MOTION_OPERATIONS.createTrack,
          { documentId: "document_main", track: positionTrack() },
          "create_track"
        )
      ])
    );
    const before = history.getBranchHead("main");

    await expect(
      transactionEngine.execute(
        proposal(
          [
            operation(
              STANDARD_MOTION_OPERATIONS.deleteKeyframe,
              {
                documentId: "document_main",
                trackId: "track_headline_position",
                keyframeId: "keyframe_start"
              },
              "delete_last"
            )
          ],
          "transaction_delete_last"
        )
      )
    ).rejects.toThrow(/last keyframe/i);
    expect(history.getBranchHead("main")).toBe(before);

    await transactionEngine.execute(
      proposal(
        [
          operation(
            STANDARD_MOTION_OPERATIONS.removeTrack,
            {
              documentId: "document_main",
              trackId: "track_headline_position",
              replacementValue: [1040, 620]
            },
            "remove_track"
          )
        ],
        "transaction_remove_track"
      )
    );
    expect(documentAtHead(history).data.tracks).toEqual({});
    expect(documentAtHead(history).data.nodes.node_headline?.properties.position).toEqual(
      constant([1040, 620])
    );
  });

  it("sets and clears the easing owned by an outgoing keyframe", async () => {
    const { history, transactionEngine } = authoringEngine();
    const track = {
      ...positionTrack(),
      keyframes: {
        keyframe_start: {
          keyframeId: "keyframe_start",
          time: seconds(0),
          value: [960, 620]
        }
      }
    };
    await transactionEngine.execute(
      proposal([
        operation(
          STANDARD_MOTION_OPERATIONS.createTrack,
          { documentId: "document_main", track },
          "create_track"
        ),
        operation(
          STANDARD_MOTION_OPERATIONS.setKeyframeEasing,
          {
            documentId: "document_main",
            trackId: "track_headline_position",
            keyframeId: "keyframe_start",
            easing: { kind: STANDARD_KEYFRAME_EASINGS.hold }
          },
          "set_easing"
        )
      ])
    );
    expect(
      documentAtHead(history).data.tracks.track_headline_position?.keyframes.keyframe_start?.easing
    ).toEqual({ kind: STANDARD_KEYFRAME_EASINGS.hold });

    await transactionEngine.execute(
      proposal(
        [
          operation(
            STANDARD_MOTION_OPERATIONS.setKeyframeEasing,
            {
              documentId: "document_main",
              trackId: "track_headline_position",
              keyframeId: "keyframe_start",
              easing: null
            },
            "clear_easing"
          )
        ],
        "transaction_clear_easing"
      )
    );
    expect(
      documentAtHead(history).data.tracks.track_headline_position?.keyframes.keyframe_start?.easing
    ).toBeUndefined();
  });

  it("prevents duration edits and keyframes from crossing the composition end", async () => {
    const { history, transactionEngine } = authoringEngine();
    await transactionEngine.execute(
      proposal([
        operation(
          STANDARD_MOTION_OPERATIONS.createTrack,
          { documentId: "document_main", track: positionTrack() },
          "create_track"
        ),
        operation(
          STANDARD_MOTION_OPERATIONS.upsertKeyframe,
          {
            documentId: "document_main",
            trackId: "track_headline_position",
            keyframe: { keyframeId: "keyframe_end", time: seconds(5), value: [1200, 620] }
          },
          "add_keyframe"
        )
      ])
    );
    const before = history.getBranchHead("main");

    await expect(
      transactionEngine.execute(
        proposal(
          [
            operation(
              STANDARD_MOTION_OPERATIONS.setDuration,
              { documentId: "document_main", duration: seconds(4) },
              "shorten"
            )
          ],
          "transaction_shorten"
        )
      )
    ).rejects.toThrow(/cannot end before/i);
    await expect(
      transactionEngine.execute(
        proposal(
          [
            operation(
              STANDARD_MOTION_OPERATIONS.upsertKeyframe,
              {
                documentId: "document_main",
                trackId: "track_headline_position",
                keyframe: { keyframeId: "keyframe_late", time: seconds(6), value: [1400, 620] }
              },
              "late_keyframe"
            )
          ],
          "transaction_late"
        )
      )
    ).rejects.toThrow(/cannot exceed/i);
    expect(history.getBranchHead("main")).toBe(before);
  });

  it("validates manually-authored keyframes against the duration", () => {
    const document = createStandardComposition();
    const track = positionTrack();
    track.keyframes.keyframe_start.time = seconds(6);
    document.data.tracks[track.trackId] = track;
    document.data.nodes.node_headline!.properties.position = {
      kind: "track",
      trackId: track.trackId
    };

    expect(validateStandardComposition(document)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "standard-motion.keyframe.after-duration" })
      ])
    );
  });

  it("does not allow set-property to bypass the track lifecycle", async () => {
    const { history, transactionEngine } = authoringEngine();
    await transactionEngine.execute(
      proposal([
        operation(
          STANDARD_MOTION_OPERATIONS.createTrack,
          { documentId: "document_main", track: positionTrack() },
          "create_track"
        )
      ])
    );
    const before = history.getBranchHead("main");

    await expect(
      transactionEngine.execute(
        proposal(
          [
            operation(
              STANDARD_MOTION_OPERATIONS.setProperty,
              {
                documentId: "document_main",
                nodeId: "node_headline",
                property: "position",
                binding: constant([0, 0])
              },
              "overwrite_track"
            )
          ],
          "transaction_overwrite_track"
        )
      )
    ).rejects.toThrow(/remove its track explicitly/i);
    expect(history.getBranchHead("main")).toBe(before);
  });
});
