import { createOutputFramePlan } from "@kineweave/project-session";
import type { Diagnostic } from "@kineweave/protocol";
import {
  exportProjectBundleOutput,
  type ProjectBundleOutputRequest,
  type ProjectOutputFormat,
  type ProjectOutputResult
} from "./project-output.js";

export type ProjectOutputJobStatus =
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ProjectOutputJobFailure {
  readonly message: string;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ProjectOutputJobSnapshot {
  readonly jobId: string;
  readonly ownerId: string;
  readonly status: ProjectOutputJobStatus;
  readonly format: ProjectOutputFormat;
  readonly completedFrames: number;
  readonly totalFrames: number;
  readonly outputPath: string;
  readonly result?: ProjectOutputResult;
  readonly error?: ProjectOutputJobFailure;
}

export interface StartProjectOutputJobRequest
  extends Omit<ProjectBundleOutputRequest, "signal" | "onProgress"> {
  readonly jobId: string;
  readonly ownerId: string;
}

interface ManagedOutputJob {
  snapshot: ProjectOutputJobSnapshot;
  readonly controller: AbortController;
  completion: Promise<void>;
}

function failure(caught: unknown): ProjectOutputJobFailure {
  const message = caught instanceof Error ? caught.message : String(caught);
  const diagnostics =
    caught !== null &&
    typeof caught === "object" &&
    "diagnostics" in caught &&
    Array.isArray(caught.diagnostics)
      ? (caught.diagnostics as Diagnostic[])
      : [];
  return { message, diagnostics };
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new TypeError(`${label} must be an opaque identifier`);
  }
}

export class ProjectOutputJobManager {
  readonly #jobs = new Map<string, ManagedOutputJob>();
  #activeJobId: string | undefined;

  start(request: StartProjectOutputJobRequest): ProjectOutputJobSnapshot {
    assertIdentifier(request.jobId, "Output job ID");
    assertIdentifier(request.ownerId, "Output owner ID");
    if (this.#jobs.has(request.jobId)) throw new TypeError(`Duplicate output job ${request.jobId}`);
    if (this.#activeJobId !== undefined) {
      throw new Error(`Output job ${this.#activeJobId} is already running`);
    }
    const plan = createOutputFramePlan({
      startTime: request.startTime,
      endTimeExclusive: request.endTimeExclusive,
      framesPerSecond: request.framesPerSecond
    });
    const controller = new AbortController();
    const job: ManagedOutputJob = {
      snapshot: {
        jobId: request.jobId,
        ownerId: request.ownerId,
        status: "running",
        format: request.format,
        completedFrames: 0,
        totalFrames: plan.frameCount,
        outputPath: request.outputPath
      },
      controller,
      completion: Promise.resolve()
    };
    this.#jobs.set(request.jobId, job);
    this.#activeJobId = request.jobId;
    job.completion = this.#run(job, {
      ...request,
      bundle: structuredClone(request.bundle),
      signal: controller.signal,
      onProgress: (completedFrames) => {
        job.snapshot = { ...job.snapshot, completedFrames };
      }
    });
    return structuredClone(job.snapshot);
  }

  snapshot(ownerId: string, jobId: string): ProjectOutputJobSnapshot {
    return structuredClone(this.#ownedJob(ownerId, jobId).snapshot);
  }

  async cancel(ownerId: string, jobId: string): Promise<ProjectOutputJobSnapshot> {
    const job = this.#ownedJob(ownerId, jobId);
    if (job.snapshot.status === "running") {
      job.snapshot = { ...job.snapshot, status: "cancelling" };
      job.controller.abort(new DOMException("Output job cancelled", "AbortError"));
    }
    await job.completion;
    return structuredClone(job.snapshot);
  }

  async removeOwner(ownerId: string): Promise<readonly ProjectOutputJobSnapshot[]> {
    const jobs = [...this.#jobs.values()].filter((job) => job.snapshot.ownerId === ownerId);
    for (const job of jobs) {
      if (job.snapshot.status === "running") {
        job.snapshot = { ...job.snapshot, status: "cancelling" };
        job.controller.abort(new DOMException("Output owner closed", "AbortError"));
      }
    }
    await Promise.all(jobs.map((job) => job.completion));
    for (const job of jobs) this.#jobs.delete(job.snapshot.jobId);
    return jobs.map((job) => structuredClone(job.snapshot));
  }

  async dispose(): Promise<void> {
    const owners = new Set([...this.#jobs.values()].map((job) => job.snapshot.ownerId));
    await Promise.all([...owners].map((ownerId) => this.removeOwner(ownerId)));
  }

  async #run(job: ManagedOutputJob, request: ProjectBundleOutputRequest): Promise<void> {
    try {
      const result = await exportProjectBundleOutput(request);
      job.snapshot = {
        ...job.snapshot,
        status: "succeeded",
        completedFrames: job.snapshot.totalFrames,
        result
      };
    } catch (caught) {
      job.snapshot = job.controller.signal.aborted
        ? { ...job.snapshot, status: "cancelled" }
        : { ...job.snapshot, status: "failed", error: failure(caught) };
    } finally {
      if (this.#activeJobId === job.snapshot.jobId) this.#activeJobId = undefined;
    }
  }

  #ownedJob(ownerId: string, jobId: string): ManagedOutputJob {
    const job = this.#jobs.get(jobId);
    if (job === undefined || job.snapshot.ownerId !== ownerId) {
      throw new Error(`Unknown output job ${jobId}`);
    }
    return job;
  }
}
