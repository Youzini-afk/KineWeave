import { randomUUID } from "node:crypto";
import {
  createOfficialDistributionProfile,
  KINEWEAVE_VERSION
} from "@kineweave/official-distribution";
import { NodeProjectRepository } from "@kineweave/project-repository-node";
import type { ProjectSessionHost } from "@kineweave/project-session";
import {
  type OpenNodeProjectSessionResult,
  openNodeProjectSession
} from "@kineweave/project-session-node";

export function createCliSessionHost(): ProjectSessionHost {
  return {
    hostKind: "cli",
    supportedRuntimes: ["in-process"],
    environment: {
      operatingSystem: process.platform,
      architecture: process.arch
    },
    createCommitId: () => `commit_${randomUUID().replaceAll("-", "")}`,
    now: () => new Date()
  };
}

export function openCliProject(
  projectPath: string,
  repository = new NodeProjectRepository()
): Promise<OpenNodeProjectSessionResult> {
  return openNodeProjectSession({
    projectPath,
    repository,
    kineweaveVersion: KINEWEAVE_VERSION,
    distribution: createOfficialDistributionProfile(),
    host: createCliSessionHost()
  });
}
