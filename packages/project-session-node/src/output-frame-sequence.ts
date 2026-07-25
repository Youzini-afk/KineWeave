import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashBytes, hashUtf8 } from "@kineweave/content-hash";
import {
  createOutputFramePlan,
  type OutputFramePlan,
  type OutputFrameSequenceRequest,
  type OutputFrameSequenceResult
} from "@kineweave/project-session";
import { type JsonObject, STANDARD_TIME_DOMAINS } from "@kineweave/protocol";
import {
  type ExpectedOutputArtifact,
  type OutputFrameShape,
  validateOutputFrame
} from "./output-frame-validation.js";

export interface PublishOutputFrameSequenceRequest {
  readonly outputDirectory: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly sourceCommitId: string;
  readonly profileId: string;
  readonly plan: OutputFramePlan;
  readonly evaluation: OutputFrameSequenceRequest["evaluation"];
  readonly rendering: OutputFrameSequenceRequest["rendering"];
  readonly expectedArtifact: ExpectedOutputArtifact;
  readonly delivery?: JsonObject;
  readonly onProgress?: (completedFrames: number, totalFrames: number) => void;
  readonly frames: AsyncIterable<OutputFrameSequenceResult>;
}

export interface PublishedOutputFrameSequence {
  readonly outputDirectory: string;
  readonly manifestPath: string;
  readonly frameCount: number;
  readonly sourceCommitId: string;
  readonly rendererProviderId: string;
  readonly mediaType: string;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function publishOutputFrameSequence(
  request: PublishOutputFrameSequenceRequest
): Promise<PublishedOutputFrameSequence> {
  if (request.evaluation.documentId !== request.documentId) {
    throw new TypeError("Output frame sequence document does not match its evaluation request");
  }
  const plan = createOutputFramePlan(request.plan);
  const absoluteOutputDirectory = path.resolve(request.outputDirectory);
  if (absoluteOutputDirectory === path.parse(absoluteOutputDirectory).root) {
    throw new TypeError("Output directory cannot be a filesystem root");
  }
  if (await pathExists(absoluteOutputDirectory)) {
    throw new TypeError(`Output directory already exists: ${absoluteOutputDirectory}`);
  }

  const outputParent = path.dirname(absoluteOutputDirectory);
  await mkdir(outputParent, { recursive: true });
  const stagingDirectory = await mkdtemp(
    path.join(outputParent, `.${path.basename(absoluteOutputDirectory)}.tmp-`)
  );
  let published = false;
  try {
    const framesDirectory = path.join(stagingDirectory, "frames");
    await mkdir(framesDirectory);
    const fileNameWidth = Math.max(6, String(plan.frameCount - 1).length);
    const frames: Array<{
      readonly frameIndex: number;
      readonly time: OutputFrameSequenceResult["time"]["value"];
      readonly file: string;
      readonly contentHash: string;
    }> = [];
    let outputShape: OutputFrameShape | undefined;

    for await (const frame of request.frames) {
      const currentShape = validateOutputFrame(
        frame,
        plan,
        frames.length,
        request.sourceCommitId,
        request.expectedArtifact,
        outputShape
      );
      const artifact = frame.rendering.artifact;
      outputShape ??= currentShape;
      const fileName = `frame_${String(frame.frameIndex).padStart(fileNameWidth, "0")}${currentShape.fileExtension}`;
      if (artifact.kind === "text") {
        await writeFile(path.join(framesDirectory, fileName), artifact.text, "utf8");
      } else {
        await writeFile(path.join(framesDirectory, fileName), artifact.bytes);
      }
      frames.push({
        frameIndex: frame.frameIndex,
        time: frame.time.value,
        file: path.posix.join("frames", fileName),
        contentHash: artifact.kind === "text" ? hashUtf8(artifact.text) : hashBytes(artifact.bytes)
      });
      request.onProgress?.(frames.length, plan.frameCount);
    }
    if (frames.length !== plan.frameCount || outputShape === undefined) {
      throw new Error(
        `Output frame sequence produced ${frames.length} of ${plan.frameCount} frames`
      );
    }

    const manifest = {
      manifestVersion: 1,
      kind: "org.kineweave.export/frame-sequence",
      source: {
        projectId: request.projectId,
        documentId: request.documentId,
        commitId: request.sourceCommitId
      },
      timing: {
        timeDomain: STANDARD_TIME_DOMAINS.seconds,
        startTime: plan.startTime,
        endTimeExclusive: plan.endTimeExclusive,
        framesPerSecond: plan.framesPerSecond,
        frameCount: plan.frameCount
      },
      evaluation: {
        viewport: request.evaluation.viewport,
        colorSpace: request.evaluation.colorSpace,
        locale: request.evaluation.locale,
        randomSeed: request.evaluation.randomSeed,
        externalSignals: request.evaluation.externalSignals
      },
      output: {
        profileId: request.profileId,
        target: request.rendering.target,
        requiredFeatures: request.rendering.requiredFeatures ?? [],
        settings: request.rendering.settings ?? {},
        ...(request.rendering.preferredProviderIds === undefined
          ? {}
          : { preferredProviderIds: request.rendering.preferredProviderIds }),
        ...outputShape,
        ...(request.delivery === undefined ? {} : { delivery: request.delivery })
      },
      frames
    };
    await writeFile(
      path.join(stagingDirectory, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );
    if (await pathExists(absoluteOutputDirectory)) {
      throw new TypeError(`Output directory already exists: ${absoluteOutputDirectory}`);
    }
    await rename(stagingDirectory, absoluteOutputDirectory);
    published = true;
    return {
      outputDirectory: absoluteOutputDirectory,
      manifestPath: path.join(absoluteOutputDirectory, "manifest.json"),
      frameCount: plan.frameCount,
      sourceCommitId: request.sourceCommitId,
      rendererProviderId: outputShape.rendererProviderId,
      mediaType: outputShape.mediaType
    };
  } finally {
    if (!published) await rm(stagingDirectory, { recursive: true, force: true });
  }
}
