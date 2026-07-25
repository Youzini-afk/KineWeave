import { rational } from "@kineweave/protocol";
import { describe, expect, it } from "vitest";
import { createOutputFramePlan, outputFrameAt, renderOutputFrames } from "./output-sequence.js";
import type { ProjectSession } from "./project-session.js";

describe("output frame planning", () => {
  it("plans an exact end-exclusive sequence without floating point drift", () => {
    const plan = createOutputFramePlan({
      startTime: rational(0),
      endTimeExclusive: rational(5),
      framesPerSecond: rational(30)
    });

    expect(plan.frameCount).toBe(150);
    expect(outputFrameAt(plan, 0).time.value).toEqual(rational(0));
    expect(outputFrameAt(plan, 149).time.value).toEqual(rational(149, 30));
  });

  it("rounds a partial tail up and preserves fractional frame rates", () => {
    const partial = createOutputFramePlan({
      startTime: rational(0),
      endTimeExclusive: rational(1, 10),
      framesPerSecond: rational(24)
    });
    const ntsc = createOutputFramePlan({
      startTime: rational(0),
      endTimeExclusive: rational(1),
      framesPerSecond: rational(30_000, 1_001)
    });

    expect(partial.frameCount).toBe(3);
    expect(outputFrameAt(partial, 2).time.value).toEqual(rational(1, 12));
    expect(ntsc.frameCount).toBe(30);
    expect(outputFrameAt(ntsc, 29).time.value).toEqual(rational(29_029, 30_000));
  });

  it("rejects invalid ranges, rates and frame indices", () => {
    expect(() =>
      createOutputFramePlan({
        startTime: rational(-1),
        endTimeExclusive: rational(1),
        framesPerSecond: rational(30)
      })
    ).toThrow(/cannot be negative/);
    expect(() =>
      createOutputFramePlan({
        startTime: rational(1),
        endTimeExclusive: rational(1),
        framesPerSecond: rational(30)
      })
    ).toThrow(/after its start/);
    expect(() =>
      createOutputFramePlan({
        startTime: rational(0),
        endTimeExclusive: rational(1),
        framesPerSecond: rational(0)
      })
    ).toThrow(/must be positive/);

    const plan = createOutputFramePlan({
      startTime: rational(0),
      endTimeExclusive: rational(1),
      framesPerSecond: rational(1)
    });
    expect(() => outputFrameAt(plan, 1)).toThrow(/outside the frame plan/);
  });

  it("pins a branch before asynchronous frame production starts", async () => {
    let branchHead = "commit_a";
    const evaluatedCommits: string[] = [];
    const session = {
      history: {
        mainBranchName: "main",
        getBranchHead: () => branchHead,
        hasCommit: () => true
      },
      async evaluate(request: { state?: { kind: string; commitId?: string }; time: unknown }) {
        evaluatedCommits.push(request.state?.commitId ?? "missing");
        return { graph: { time: request.time } };
      },
      async renderOutput() {
        return {
          artifact: {
            kind: "text",
            mediaType: "image/svg+xml",
            fileExtension: ".svg",
            text: "<svg/>"
          },
          provider: { providerId: "org.kineweave.renderer/test" },
          diagnostics: []
        };
      }
    } as unknown as ProjectSession;
    const plan = createOutputFramePlan({
      startTime: rational(0),
      endTimeExclusive: rational(1, 15),
      framesPerSecond: rational(30)
    });
    const frames = renderOutputFrames(session, {
      plan,
      evaluation: {
        documentId: "document_main",
        state: { kind: "branch", branchName: "main" },
        viewport: { width: 1920, height: 1080, pixelRatio: rational(1) },
        colorSpace: "org.kineweave.color/srgb",
        locale: "en-US",
        randomSeed: "test",
        externalSignals: {}
      },
      rendering: { target: "org.kineweave.output/svg" }
    });
    branchHead = "commit_b";

    const results = [];
    for await (const frame of frames) results.push(frame);
    expect(results.map((frame) => frame.sourceCommitId)).toEqual(["commit_a", "commit_a"]);
    expect(evaluatedCommits).toEqual(["commit_a", "commit_a"]);
  });
});
