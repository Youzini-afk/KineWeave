import { randomUUID } from "node:crypto";
import type { LoadedProjectBundle } from "@kineweave/project-format";
import {
  createOutputFramePlan,
  type KineWeaveDistributionProfile,
  ProjectSession,
  renderOutputFrames
} from "@kineweave/project-session";
import {
  compareRational,
  type Diagnostic,
  hasErrorDiagnostics,
  type JsonObject,
  type KineWeaveProjectManifest,
  parseRational,
  type Rational,
  STANDARD_COLOR_SPACES,
  STANDARD_TIME_DOMAINS
} from "@kineweave/protocol";
import {
  STANDARD_COMPOSITION_TYPE,
  type StandardCompositionDocument
} from "@kineweave/standard-motion-document";
import {
  type PublishedOutputFrameSequence,
  publishOutputFrameSequence
} from "./output-frame-sequence.js";
import {
  type OutputVideoQuality,
  type PublishedOutputVideo,
  publishOutputVideo
} from "./output-video.js";
import { rasterizeSvgOutputFrames } from "./rasterize-svg.js";

export type ProjectOutputFormat = "svg-sequence" | "png-sequence" | "mp4" | "webm";
export type ProjectOutputResult = PublishedOutputFrameSequence | PublishedOutputVideo;

export interface ProjectOutputRequest {
  readonly outputPath: string;
  readonly documentId: string;
  readonly format: ProjectOutputFormat;
  readonly startTime: Rational;
  readonly endTimeExclusive: Rational;
  readonly framesPerSecond: Rational;
  readonly viewport: {
    readonly width: number;
    readonly height: number;
    readonly pixelRatio: Rational;
  };
  readonly quality?: OutputVideoQuality;
  readonly profileId?: string;
  readonly preferredProviderIds?: readonly string[];
  readonly sourceCommitId?: string;
  readonly colorSpace?: string;
  readonly locale?: string;
  readonly randomSeed?: string;
  readonly externalSignals?: JsonObject;
  readonly signal?: AbortSignal;
  readonly onProgress?: (completedFrames: number, totalFrames: number) => void;
}

export interface ProjectBundleOutputRequest extends ProjectOutputRequest {
  readonly bundle: LoadedProjectBundle;
  readonly kineweaveVersion: string;
  readonly distribution: KineWeaveDistributionProfile;
}

export class ProjectOutputError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(message: string, diagnostics: readonly Diagnostic[] = []) {
    super(message);
    this.name = "ProjectOutputError";
    this.diagnostics = diagnostics;
  }
}

function outputProfile(manifest: KineWeaveProjectManifest, requestedId?: string) {
  const profileId = requestedId ?? Object.keys(manifest.outputProfiles)[0];
  if (profileId === undefined) throw new TypeError("Project has no output profile");
  const profile = manifest.outputProfiles[profileId];
  if (profile === undefined) throw new TypeError(`Unknown output profile ${profileId}`);
  return { profileId, profile };
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

export async function exportProjectSessionOutput(
  session: ProjectSession,
  manifest: KineWeaveProjectManifest,
  request: ProjectOutputRequest
): Promise<ProjectOutputResult> {
  const sourceCommitId =
    request.sourceCommitId ?? session.history.getBranchHead(session.history.mainBranchName);
  if (!session.history.hasCommit(sourceCommitId)) {
    throw new TypeError(`Unknown commit ${sourceCommitId}`);
  }
  const rawDocument = session.history.stateAt(sourceCommitId)[request.documentId];
  if (
    rawDocument === null ||
    typeof rawDocument !== "object" ||
    (rawDocument as { readonly documentType?: unknown }).documentType !== STANDARD_COMPOSITION_TYPE
  ) {
    throw new TypeError(
      `Animation output requires a Standard Motion composition: ${request.documentId}`
    );
  }
  const composition = rawDocument as unknown as StandardCompositionDocument;
  if (composition.data.duration.domain !== STANDARD_TIME_DOMAINS.seconds) {
    throw new TypeError(
      `Animation output requires a time-domain mapper for ${composition.data.duration.domain}`
    );
  }
  const startTime = parseRational(request.startTime);
  const endTimeExclusive = parseRational(request.endTimeExclusive);
  if (compareRational(endTimeExclusive, composition.data.duration.value) > 0) {
    throw new RangeError("Output end time cannot exceed the composition duration");
  }
  if (request.quality !== undefined && request.format !== "mp4" && request.format !== "webm") {
    throw new TypeError("Video quality is only available for mp4 and webm output");
  }
  const plan = createOutputFramePlan({
    startTime,
    endTimeExclusive,
    framesPerSecond: parseRational(request.framesPerSecond)
  });
  const { profileId, profile } = outputProfile(manifest, request.profileId);
  const evaluation = {
    documentId: request.documentId,
    state: { kind: "commit" as const, commitId: sourceCommitId },
    viewport: {
      width: positiveInteger(request.viewport.width, "Output width"),
      height: positiveInteger(request.viewport.height, "Output height"),
      pixelRatio: parseRational(request.viewport.pixelRatio)
    },
    colorSpace:
      request.colorSpace ?? composition.data.canvas.colorSpace ?? STANDARD_COLOR_SPACES.srgb,
    locale: request.locale ?? "en-US",
    randomSeed: request.randomSeed ?? "kineweave-output",
    outputProfileId: profileId,
    externalSignals: structuredClone(request.externalSignals ?? {})
  };
  const rendering = {
    target: profile.target,
    requiredFeatures: profile.requiredFeatures ?? [],
    settings: profile.settings,
    ...(request.preferredProviderIds === undefined
      ? {}
      : { preferredProviderIds: request.preferredProviderIds })
  };
  const sourceFrames = renderOutputFrames(session, {
    plan,
    evaluation,
    rendering,
    ...(request.signal === undefined ? {} : { signal: request.signal })
  });
  if (request.format === "svg-sequence") {
    return publishOutputFrameSequence({
      outputDirectory: request.outputPath,
      projectId: manifest.projectId,
      documentId: request.documentId,
      sourceCommitId,
      profileId,
      plan,
      evaluation,
      rendering,
      expectedArtifact: { mediaType: "image/svg+xml", fileExtension: ".svg" },
      delivery: { kind: "direct-renderer-artifact" },
      ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress }),
      frames: sourceFrames
    });
  }

  const pngFrames = rasterizeSvgOutputFrames(sourceFrames, {
    ...(request.format === "mp4" || request.format === "webm" ? { background: "#000000" } : {}),
    ...(request.signal === undefined ? {} : { signal: request.signal })
  });
  if (request.format === "png-sequence") {
    return publishOutputFrameSequence({
      outputDirectory: request.outputPath,
      projectId: manifest.projectId,
      documentId: request.documentId,
      sourceCommitId,
      profileId,
      plan,
      evaluation,
      rendering,
      expectedArtifact: { mediaType: "image/png", fileExtension: ".png", kind: "binary" },
      delivery: {
        kind: "rasterized-svg",
        rasterizer: "@resvg/resvg-js",
        fontPackage: "@fontsource-variable/noto-sans-sc"
      },
      ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress }),
      frames: pngFrames
    });
  }
  return publishOutputVideo({
    outputPath: request.outputPath,
    projectId: manifest.projectId,
    documentId: request.documentId,
    sourceCommitId,
    profileId,
    plan,
    evaluation,
    format: request.format,
    ...(request.quality === undefined ? {} : { quality: request.quality }),
    frames: pngFrames,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress })
  });
}

export async function exportProjectBundleOutput(
  request: ProjectBundleOutputRequest
): Promise<ProjectOutputResult> {
  request.signal?.throwIfAborted();
  const opened = await ProjectSession.open({
    bundle: request.bundle,
    kineweaveVersion: request.kineweaveVersion,
    distribution: request.distribution,
    host: {
      hostKind: "render-node",
      supportedRuntimes: ["in-process"],
      environment: { operatingSystem: process.platform, architecture: process.arch },
      createCommitId: () => `commit_${randomUUID().replaceAll("-", "")}`,
      now: () => new Date()
    }
  });
  if (opened.session === undefined || hasErrorDiagnostics(opened.diagnostics)) {
    await opened.session?.dispose();
    throw new ProjectOutputError("Output runtime could not open the project", opened.diagnostics);
  }
  try {
    return await exportProjectSessionOutput(opened.session, request.bundle.manifest, request);
  } finally {
    await opened.session.dispose();
  }
}
