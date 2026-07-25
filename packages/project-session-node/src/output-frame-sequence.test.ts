import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOutputFramePlan, type OutputFrameSequenceResult } from "@kineweave/project-session";
import { rational } from "@kineweave/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { publishOutputFrameSequence } from "./output-frame-sequence.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("Node output frame sequence publishing", () => {
  it("removes its staging directory when frame production fails", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "kineweave-output-sequence-"));
    temporaryDirectories.push(parent);
    const plan = createOutputFramePlan({
      startTime: rational(0),
      endTimeExclusive: rational(1),
      framesPerSecond: rational(1)
    });
    const frames: AsyncIterable<OutputFrameSequenceResult> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            throw new Error("frame production failed");
          }
        };
      }
    };

    await expect(
      publishOutputFrameSequence({
        outputDirectory: path.join(parent, "sequence"),
        projectId: "project_test",
        documentId: "document_main",
        sourceCommitId: "commit_test",
        profileId: "svg",
        plan,
        evaluation: {
          documentId: "document_main",
          viewport: { width: 1920, height: 1080, pixelRatio: rational(1) },
          colorSpace: "org.kineweave.color/srgb",
          locale: "en-US",
          randomSeed: "test",
          externalSignals: {}
        },
        rendering: { target: "org.kineweave.output/svg" },
        expectedArtifact: { mediaType: "image/svg+xml", fileExtension: ".svg" },
        frames
      })
    ).rejects.toThrow("frame production failed");
    expect(await readdir(parent)).toEqual([]);
  });
});
