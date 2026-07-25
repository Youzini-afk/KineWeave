import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  createOfficialDistributionProfile,
  createOfficialProjectTemplate,
  KINEWEAVE_VERSION
} from "@kineweave/official-distribution";
import { rational } from "@kineweave/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProjectOutputJobManager,
  type ProjectOutputJobSnapshot,
  type StartProjectOutputJobRequest
} from "./output-job-manager.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function outputRequest(root: string, jobId: string): StartProjectOutputJobRequest {
  return {
    jobId,
    ownerId: "studio_owner_one",
    outputPath: path.join(root, jobId),
    bundle: createOfficialProjectTemplate({ name: "Output Job", projectId: "project_output_job" }),
    kineweaveVersion: KINEWEAVE_VERSION,
    distribution: createOfficialDistributionProfile(),
    documentId: "document_main",
    format: "svg-sequence",
    startTime: rational(0),
    endTimeExclusive: rational(1, 30),
    framesPerSecond: rational(30),
    viewport: { width: 64, height: 64, pixelRatio: rational(1) }
  };
}

async function terminalJob(
  manager: ProjectOutputJobManager,
  ownerId: string,
  jobId: string
): Promise<ProjectOutputJobSnapshot> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = manager.snapshot(ownerId, jobId);
    if (job.status !== "running" && job.status !== "cancelling") return job;
    await delay(5);
  }
  throw new Error(`Output job ${jobId} did not finish`);
}

describe("ProjectOutputJobManager", () => {
  it("pins an owner-scoped job and publishes its immutable SVG snapshot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kineweave-output-job-"));
    temporaryDirectories.push(root);
    const manager = new ProjectOutputJobManager();
    const request = outputRequest(root, "output_job_one");

    expect(manager.start(request)).toMatchObject({ status: "running", totalFrames: 1 });
    expect(() => manager.snapshot("studio_owner_two", request.jobId)).toThrow("Unknown output job");
    expect(() => manager.start(outputRequest(root, "output_job_two"))).toThrow(
      "is already running"
    );

    const completed = await terminalJob(manager, request.ownerId, request.jobId);
    expect(completed).toMatchObject({ status: "succeeded", completedFrames: 1, totalFrames: 1 });
    expect(completed.result).toMatchObject({ frameCount: 1, mediaType: "image/svg+xml" });
    await manager.dispose();
  });

  it("turns an abort into a cancelled terminal state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kineweave-output-cancel-"));
    temporaryDirectories.push(root);
    const manager = new ProjectOutputJobManager();
    const request = outputRequest(root, "output_job_cancel");
    manager.start(request);

    await expect(manager.cancel(request.ownerId, request.jobId)).resolves.toMatchObject({
      status: "cancelled"
    });
    await manager.dispose();
  });
});
