import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { link, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";
import {
  createOutputFramePlan,
  type OutputFramePlan,
  type OutputFrameSequenceRequest,
  type OutputFrameSequenceResult
} from "@kineweave/project-session";
import type { JsonObject, Rational } from "@kineweave/protocol";
import { type OutputFrameShape, validateOutputFrame } from "./output-frame-validation.js";

export type OutputVideoFormat = "mp4" | "webm";
export type OutputVideoQuality = "high" | "balanced" | "compact";

export interface PublishOutputVideoRequest {
  readonly outputPath: string;
  readonly projectId: string;
  readonly documentId: string;
  readonly sourceCommitId: string;
  readonly profileId: string;
  readonly plan: OutputFramePlan;
  readonly evaluation: OutputFrameSequenceRequest["evaluation"];
  readonly format: OutputVideoFormat;
  readonly quality?: OutputVideoQuality;
  readonly frames: AsyncIterable<OutputFrameSequenceResult>;
  readonly ffmpegPath?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (completedFrames: number, totalFrames: number) => void;
}

export interface PublishedOutputVideo {
  readonly outputPath: string;
  readonly mediaType: "video/mp4" | "video/webm";
  readonly format: OutputVideoFormat;
  readonly codec: "h264" | "vp9";
  readonly quality: OutputVideoQuality;
  readonly frameCount: number;
  readonly framesPerSecond: Rational;
  readonly projectId: string;
  readonly documentId: string;
  readonly sourceCommitId: string;
  readonly profileId: string;
  readonly rendererProviderId: string;
  readonly frameArtifactMetadata: JsonObject;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly width: number;
  readonly height: number;
  readonly ffmpegVersion: string;
  readonly contentHash: string;
}

interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function processExit(child: ChildProcess): Promise<ProcessExit> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function abortProcess(child: ChildProcess, signal?: AbortSignal): () => void {
  if (signal === undefined) return () => undefined;
  const terminate = () => {
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
    force.unref();
  };
  signal.addEventListener("abort", terminate, { once: true });
  if (signal.aborted) terminate();
  return () => signal.removeEventListener("abort", terminate);
}

function ffmpegExecutable(explicitPath?: string): string {
  const executable = explicitPath ?? process.env.KINEWEAVE_FFMPEG_PATH ?? "ffmpeg";
  if (executable.trim().length === 0) {
    throw new TypeError("FFmpeg path cannot be empty");
  }
  return executable;
}

async function readFfmpegVersion(executable: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const child = spawn(executable, ["-version"], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (stdout.length < 16_384) stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 16_384) stderr += chunk;
  });
  const removeAbort = abortProcess(child, signal);
  try {
    const result = await processExit(child);
    signal?.throwIfAborted();
    if (result.code !== 0) {
      throw new Error(`FFmpeg version check failed: ${stderr.trim() || `exit ${result.code}`}`);
    }
    const firstLine = stdout.split(/\r?\n/, 1)[0]?.trim();
    const version = /^ffmpeg version (\S+)/.exec(firstLine ?? "")?.[1];
    if (version === undefined) {
      throw new Error("FFmpeg returned an unrecognized version response");
    }
    return version;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new TypeError("FFmpeg was not found; install ffmpeg or set KINEWEAVE_FFMPEG_PATH");
    }
    throw error;
  } finally {
    removeAbort();
  }
}

function ffmpegArguments(
  request: Pick<PublishOutputVideoRequest, "format" | "quality" | "plan">,
  outputPath: string
): readonly string[] {
  const quality = request.quality ?? "balanced";
  const common = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "image2pipe",
    "-framerate",
    `${request.plan.framesPerSecond.numerator}/${request.plan.framesPerSecond.denominator}`,
    "-i",
    "pipe:0",
    "-an",
    "-map_metadata",
    "-1",
    "-fflags",
    "+bitexact",
    "-frames:v",
    String(request.plan.frameCount),
    "-vf",
    "pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p",
    "-fps_mode",
    "cfr",
    "-threads",
    "1"
  ];
  if (request.format === "mp4") {
    const crf = { high: "16", balanced: "20", compact: "28" }[quality];
    return [
      ...common,
      "-c:v",
      "libx264",
      "-preset",
      quality === "high" ? "slow" : "medium",
      "-crf",
      crf,
      "-flags:v",
      "+bitexact",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      outputPath
    ];
  }
  const crf = { high: "24", balanced: "31", compact: "38" }[quality];
  return [
    ...common,
    "-c:v",
    "libvpx-vp9",
    "-crf",
    crf,
    "-b:v",
    "0",
    "-deadline",
    "good",
    "-cpu-used",
    quality === "high" ? "2" : quality === "balanced" ? "4" : "6",
    "-row-mt",
    "0",
    "-flags:v",
    "+bitexact",
    "-f",
    "webm",
    outputPath
  ];
}

function pngDimensions(bytes: Uint8Array): { readonly width: number; readonly height: number } {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    buffer.length < 24 ||
    !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    buffer.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new TypeError("Video encoding requires valid PNG frame artifacts");
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width === 0 || height === 0) throw new TypeError("PNG frame dimensions must be positive");
  return { width, height };
}

async function writeFrame(
  stdin: Writable,
  exit: Promise<ProcessExit>,
  bytes: Uint8Array
): Promise<void> {
  if (stdin.write(bytes)) return;
  await Promise.race([
    once(stdin, "drain"),
    exit.then((result) => {
      throw new Error(`FFmpeg closed its input early with exit ${result.code}`);
    })
  ]);
}

async function fileHash(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return `sha256:${hash.digest("hex")}`;
}

export async function publishOutputVideo(
  request: PublishOutputVideoRequest
): Promise<PublishedOutputVideo> {
  if (request.evaluation.documentId !== request.documentId) {
    throw new TypeError("Output video document does not match its evaluation request");
  }
  const plan = createOutputFramePlan(request.plan);
  if (request.format !== "mp4" && request.format !== "webm") {
    throw new TypeError("Output video format must be mp4 or webm");
  }
  const quality = request.quality ?? "balanced";
  if (quality !== "high" && quality !== "balanced" && quality !== "compact") {
    throw new TypeError("Video quality must be high, balanced or compact");
  }
  const expectedExtension = `.${request.format}`;
  const absoluteOutputPath = path.resolve(request.outputPath);
  if (absoluteOutputPath === path.parse(absoluteOutputPath).root) {
    throw new TypeError("Output video path cannot be a filesystem root");
  }
  if (path.extname(absoluteOutputPath).toLowerCase() !== expectedExtension) {
    throw new TypeError(`Output video path must end with ${expectedExtension}`);
  }
  if (await pathExists(absoluteOutputPath)) {
    throw new TypeError(`Output video already exists: ${absoluteOutputPath}`);
  }

  request.signal?.throwIfAborted();
  const executable = ffmpegExecutable(request.ffmpegPath);
  const ffmpegVersion = await readFfmpegVersion(executable, request.signal);
  const outputParent = path.dirname(absoluteOutputPath);
  await mkdir(outputParent, { recursive: true });
  const stagingDirectory = await mkdtemp(
    path.join(outputParent, `.${path.basename(absoluteOutputPath)}.tmp-`)
  );
  const stagingOutputPath = path.join(stagingDirectory, path.basename(absoluteOutputPath));
  try {
    const child = spawn(executable, ffmpegArguments({ ...request, plan }, stagingOutputPath), {
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 65_536) stderr += chunk;
    });
    child.stdin.on("error", () => undefined);
    const exit = processExit(child);
    const removeAbort = abortProcess(child, request.signal);
    let frameCount = 0;
    let shape: OutputFrameShape | undefined;
    let dimensions: { readonly width: number; readonly height: number } | undefined;
    try {
      for await (const frame of request.frames) {
        request.signal?.throwIfAborted();
        const currentShape = validateOutputFrame(
          frame,
          plan,
          frameCount,
          request.sourceCommitId,
          { mediaType: "image/png", fileExtension: ".png", kind: "binary" },
          shape
        );
        shape ??= currentShape;
        const artifact = frame.rendering.artifact;
        if (artifact.kind !== "binary") throw new TypeError("PNG frame must be binary");
        const currentDimensions = pngDimensions(artifact.bytes);
        if (
          dimensions !== undefined &&
          (dimensions.width !== currentDimensions.width ||
            dimensions.height !== currentDimensions.height)
        ) {
          throw new Error("PNG frame dimensions changed during video encoding");
        }
        dimensions ??= currentDimensions;
        await writeFrame(child.stdin, exit, artifact.bytes);
        frameCount += 1;
        request.onProgress?.(frameCount, plan.frameCount);
      }
      if (frameCount !== plan.frameCount || shape === undefined || dimensions === undefined) {
        throw new Error(`Output video produced ${frameCount} of ${plan.frameCount} frames`);
      }
      child.stdin.end();
      const result = await exit;
      request.signal?.throwIfAborted();
      if (result.code !== 0) {
        throw new Error(
          `FFmpeg encoding failed${result.signal === null ? ` with exit ${result.code}` : ` after ${result.signal}`}: ${stderr.trim() || "no diagnostic output"}`
        );
      }
      if (await pathExists(absoluteOutputPath)) {
        throw new TypeError(`Output video already exists: ${absoluteOutputPath}`);
      }
      const contentHash = await fileHash(stagingOutputPath);
      request.signal?.throwIfAborted();
      await link(stagingOutputPath, absoluteOutputPath);
      return {
        outputPath: absoluteOutputPath,
        mediaType: request.format === "mp4" ? "video/mp4" : "video/webm",
        format: request.format,
        codec: request.format === "mp4" ? "h264" : "vp9",
        quality,
        frameCount,
        framesPerSecond: plan.framesPerSecond,
        projectId: request.projectId,
        documentId: request.documentId,
        sourceCommitId: request.sourceCommitId,
        profileId: request.profileId,
        rendererProviderId: shape.rendererProviderId,
        frameArtifactMetadata: shape.artifactMetadata,
        sourceWidth: dimensions.width,
        sourceHeight: dimensions.height,
        width: dimensions.width + (dimensions.width % 2),
        height: dimensions.height + (dimensions.height % 2),
        ffmpegVersion,
        contentHash
      };
    } catch (error) {
      child.stdin.destroy();
      child.kill("SIGTERM");
      await exit.catch(() => undefined);
      throw error;
    } finally {
      removeAbort();
    }
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}
