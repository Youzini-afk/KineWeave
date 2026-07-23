import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createOfficialDistributionProfile,
  createOfficialProjectTemplate,
  KINEWEAVE_VERSION
} from "@kineweave/official-distribution";
import { NodeProjectRepository } from "@kineweave/project-repository-node";
import { afterEach, describe, expect, it } from "vitest";
import { openNodeProjectSession } from "./node-project-session.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("NodeProjectSession", () => {
  it("updates its repository snapshot after every save", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kineweave-session-node-"));
    temporaryDirectories.push(root);
    const projectPath = path.join(root, "project");
    const repository = new NodeProjectRepository();
    await repository.initialize(
      projectPath,
      createOfficialProjectTemplate({
        name: "Repeated Save",
        projectId: "project_repeated_save"
      })
    );
    let commitId = 0;
    const opened = await openNodeProjectSession({
      projectPath,
      repository,
      kineweaveVersion: KINEWEAVE_VERSION,
      distribution: createOfficialDistributionProfile(),
      host: {
        hostKind: "cli",
        supportedRuntimes: ["in-process"],
        now: () => new Date("2026-07-23T00:00:00.000Z"),
        createCommitId: () => `commit_${++commitId}`
      }
    });
    expect(opened.diagnostics).toEqual([]);
    const project = opened.project!;

    project.session.createBranch("proposal/test");
    const firstSnapshot = await project.save();
    project.session.deleteBranch("proposal/test");
    const secondSnapshot = await project.save();
    expect(secondSnapshot.fileHashes).not.toBe(firstSnapshot.fileHashes);
    await project.dispose();

    const reread = await repository.read(projectPath);
    expect(reread.diagnostics).toEqual([]);
    expect(reread.snapshot?.bundle.history.branches).toEqual({
      main: "commit_root"
    });
  });
});
