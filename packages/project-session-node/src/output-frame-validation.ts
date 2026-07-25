import { hashJson } from "@kineweave/content-hash";
import {
  type OutputFramePlan,
  type OutputFrameSequenceResult,
  outputFrameAt
} from "@kineweave/project-session";
import { compareRational, type JsonObject, STANDARD_TIME_DOMAINS } from "@kineweave/protocol";

export interface ExpectedOutputArtifact {
  readonly mediaType: string;
  readonly fileExtension: string;
  readonly kind?: OutputFrameSequenceResult["rendering"]["artifact"]["kind"];
}

export interface OutputFrameShape {
  readonly artifactKind: OutputFrameSequenceResult["rendering"]["artifact"]["kind"];
  readonly mediaType: string;
  readonly fileExtension: string;
  readonly rendererProviderId: string;
  readonly artifactMetadata: JsonObject;
}

export function validateOutputFrame(
  frame: OutputFrameSequenceResult,
  planInput: OutputFramePlan,
  expectedFrameIndex: number,
  sourceCommitId: string,
  expectedArtifact: ExpectedOutputArtifact,
  previousShape?: OutputFrameShape
): OutputFrameShape {
  const expectedFrame = outputFrameAt(planInput, expectedFrameIndex);
  if (
    frame.frameIndex !== expectedFrameIndex ||
    frame.sourceCommitId !== sourceCommitId ||
    frame.time.domain !== STANDARD_TIME_DOMAINS.seconds ||
    compareRational(frame.time.value, expectedFrame.time.value) !== 0
  ) {
    throw new Error(`Output frame sequence received unexpected frame ${frame.frameIndex}`);
  }

  const artifact = frame.rendering.artifact;
  const shape = {
    artifactKind: artifact.kind,
    mediaType: artifact.mediaType,
    fileExtension: artifact.fileExtension.toLowerCase(),
    rendererProviderId: frame.rendering.provider.providerId,
    artifactMetadata: structuredClone(artifact.metadata ?? {})
  };
  const expectedExtension = expectedArtifact.fileExtension.toLowerCase();
  if (
    shape.mediaType !== expectedArtifact.mediaType ||
    shape.fileExtension !== expectedExtension ||
    (expectedArtifact.kind !== undefined && shape.artifactKind !== expectedArtifact.kind)
  ) {
    throw new TypeError(
      `Expected ${expectedArtifact.mediaType} ${expectedExtension}, received ${artifact.mediaType} ${artifact.fileExtension}`
    );
  }
  if (
    previousShape !== undefined &&
    (previousShape.artifactKind !== shape.artifactKind ||
      previousShape.mediaType !== shape.mediaType ||
      previousShape.fileExtension !== shape.fileExtension ||
      previousShape.rendererProviderId !== shape.rendererProviderId ||
      hashJson(previousShape.artifactMetadata) !== hashJson(shape.artifactMetadata))
  ) {
    throw new Error("Output renderer changed artifact shape during the frame sequence");
  }
  return shape;
}
