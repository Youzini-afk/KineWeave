import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOutputFramePlan, type OutputFrameSequenceResult } from "@kineweave/project-session";
import { rational } from "@kineweave/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { publishOutputVideo } from "./output-video.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("Node output video publishing", () => {
  it("reports a missing host FFmpeg before consuming frames or creating staging files", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "kineweave-output-video-"));
    temporaryDirectories.push(parent);
    const plan = createOutputFramePlan({
      startTime: rational(0),
      endTimeExclusive: rational(1),
      framesPerSecond: rational(1)
    });
    let consumed = false;
    const frames: AsyncIterable<OutputFrameSequenceResult> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<OutputFrameSequenceResult>> {
            consumed = true;
            return { done: true, value: undefined };
          }
        };
      }
    };

    await expect(
      publishOutputVideo({
        outputPath: path.join(parent, "output.mp4"),
        projectId: "project_test",
        documentId: "document_main",
        sourceCommitId: "commit_test",
        profileId: "svg",
        plan,
        evaluation: {
          documentId: "document_main",
          viewport: { width: 320, height: 180, pixelRatio: rational(1) },
          colorSpace: "org.kineweave.color/srgb",
          locale: "en-US",
          randomSeed: "test",
          externalSignals: {}
        },
        format: "mp4",
        frames,
        ffmpegPath: path.join(parent, "missing-ffmpeg")
      })
    ).rejects.toThrow(/FFmpeg was not found/);
    expect(consumed).toBe(false);
    expect(await readdir(parent)).toEqual([]);
  });
});
