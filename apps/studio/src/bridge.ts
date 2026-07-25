import type { LoadedProjectBundle } from "@kineweave/project-format";
import { type Diagnostic, parseRational, type Rational, rational } from "@kineweave/protocol";

export const STUDIO_IPC_CHANNELS = {
  chooseProject: "studio.project.choose",
  openProject: "studio.project.open",
  saveProject: "studio.project.save",
  closeProject: "studio.project.close",
  startOutput: "studio.output.start",
  getOutput: "studio.output.get",
  cancelOutput: "studio.output.cancel",
  openOutput: "studio.output.open",
  initialProject: "studio.project.initial",
  command: "studio.command",
  closeResponse: "studio.window.close-response"
} as const;

export type StudioCommand =
  | "open-project"
  | "save-project"
  | "show-output"
  | "undo"
  | "redo"
  | "toggle-playback"
  | "prepare-close";

export interface StudioHostFailure {
  readonly message: string;
  readonly diagnostics: readonly Diagnostic[];
}

export type StudioHostResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: StudioHostFailure };

export interface OpenedStudioProject {
  readonly hostSessionId: string;
  readonly projectLocator: string;
  readonly displayLocation: string;
  readonly bundle: LoadedProjectBundle;
  readonly diagnostics: readonly Diagnostic[];
}

export interface SavedStudioProject {
  readonly bundle: LoadedProjectBundle;
}

export type StudioOutputFormat = "svg-sequence" | "png-sequence" | "mp4" | "webm";
export type StudioOutputQuality = "high" | "balanced" | "compact";
export type StudioOutputJobStatus = "running" | "cancelling" | "succeeded" | "failed" | "cancelled";

export interface StudioOutputRequest {
  readonly documentId: string;
  readonly format: StudioOutputFormat;
  readonly startTime: Rational;
  readonly endTimeExclusive: Rational;
  readonly framesPerSecond: Rational;
  readonly viewport: {
    readonly width: number;
    readonly height: number;
    readonly pixelRatio: Rational;
  };
  readonly quality?: StudioOutputQuality;
}

export interface StudioOutputJob {
  readonly jobId: string;
  readonly status: StudioOutputJobStatus;
  readonly format: StudioOutputFormat;
  readonly completedFrames: number;
  readonly totalFrames: number;
  readonly result?: {
    readonly fileName: string;
    readonly mediaType: string;
  };
  readonly error?: StudioHostFailure;
}

export function parseStudioRationalText(text: string, label: string): Rational {
  const value = text.trim();
  const fraction = /^(-?\d+)\/([1-9]\d*)$/.exec(value);
  if (fraction !== null) return rational(fraction[1]!, fraction[2]!);
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) {
    throw new TypeError(`${label} must be a decimal or fraction`);
  }
  const negative = value.startsWith("-");
  const [whole, decimals = ""] = (negative ? value.slice(1) : value).split(".");
  const numerator = BigInt(`${whole}${decimals}`) * (negative ? -1n : 1n);
  return rational(numerator, 10n ** BigInt(decimals.length));
}

export function parseStudioOutputRequest(value: unknown): StudioOutputRequest {
  if (value === null || typeof value !== "object") {
    throw new TypeError("Output request must be an object");
  }
  const candidate = value as Partial<StudioOutputRequest>;
  const format = candidate.format;
  if (
    format !== "svg-sequence" &&
    format !== "png-sequence" &&
    format !== "mp4" &&
    format !== "webm"
  ) {
    throw new TypeError("Output format is not supported");
  }
  const quality = candidate.quality;
  if (
    quality !== undefined &&
    quality !== "high" &&
    quality !== "balanced" &&
    quality !== "compact"
  ) {
    throw new TypeError("Output quality is not supported");
  }
  if (quality !== undefined && format !== "mp4" && format !== "webm") {
    throw new TypeError("Output quality only applies to video");
  }
  const viewport = candidate.viewport;
  if (viewport === undefined || viewport === null || typeof viewport !== "object") {
    throw new TypeError("Output viewport must be an object");
  }
  if (!Number.isSafeInteger(viewport.width) || viewport.width <= 0) {
    throw new TypeError("Output width must be a positive safe integer");
  }
  if (!Number.isSafeInteger(viewport.height) || viewport.height <= 0) {
    throw new TypeError("Output height must be a positive safe integer");
  }
  if (typeof candidate.documentId !== "string" || candidate.documentId.length === 0) {
    throw new TypeError("Output document ID must be a non-empty string");
  }
  return {
    documentId: candidate.documentId,
    format,
    startTime: parseRational(candidate.startTime),
    endTimeExclusive: parseRational(candidate.endTimeExclusive),
    framesPerSecond: parseRational(candidate.framesPerSecond),
    viewport: {
      width: viewport.width,
      height: viewport.height,
      pixelRatio: parseRational(viewport.pixelRatio)
    },
    ...(quality === undefined ? {} : { quality })
  };
}

export interface StudioHostApi {
  readonly hostKind: "desktop" | "web";
  readonly outputFormats: readonly StudioOutputFormat[];
  signOut?(): Promise<void>;
  chooseProject(): Promise<string | undefined>;
  openProject(projectLocator: string): Promise<StudioHostResult<OpenedStudioProject>>;
  saveProject(
    hostSessionId: string,
    bundle: LoadedProjectBundle
  ): Promise<StudioHostResult<SavedStudioProject>>;
  closeProject(hostSessionId: string): Promise<void>;
  startOutput(
    hostSessionId: string,
    request: StudioOutputRequest
  ): Promise<StudioHostResult<StudioOutputJob | undefined>>;
  getOutput(hostSessionId: string, jobId: string): Promise<StudioHostResult<StudioOutputJob>>;
  cancelOutput(hostSessionId: string, jobId: string): Promise<StudioHostResult<StudioOutputJob>>;
  openOutput(
    hostSessionId: string,
    jobId: string
  ): Promise<StudioHostResult<{ readonly opened: true }>>;
  respondToClose(shouldClose: boolean): void;
  onInitialProject(listener: (projectLocator: string) => void): () => void;
  onCommand(listener: (command: StudioCommand) => void): () => void;
}
