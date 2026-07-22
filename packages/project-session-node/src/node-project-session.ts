import {
  NodeProjectRepository,
  type ProjectSnapshot
} from "@kineweave/project-repository-node";
import {
  ProjectSession,
  type ProjectSessionHost,
  type KineWeaveDistributionProfile
} from "@kineweave/project-session";
import { hasErrorDiagnostics, type Diagnostic } from "@kineweave/protocol";

export interface OpenNodeProjectSessionOptions {
  readonly projectPath: string;
  readonly kineweaveVersion: string;
  readonly distribution: KineWeaveDistributionProfile;
  readonly host: ProjectSessionHost;
  readonly repository?: NodeProjectRepository;
}

export interface OpenNodeProjectSessionResult {
  readonly project?: NodeProjectSession;
  readonly diagnostics: readonly Diagnostic[];
}

export class NodeProjectSession {
  readonly session: ProjectSession;
  readonly #repository: NodeProjectRepository;
  #snapshot: ProjectSnapshot;

  constructor(
    repository: NodeProjectRepository,
    snapshot: ProjectSnapshot,
    session: ProjectSession
  ) {
    this.#repository = repository;
    this.#snapshot = snapshot;
    this.session = session;
  }

  get snapshot(): ProjectSnapshot {
    return this.#snapshot;
  }

  async save(): Promise<ProjectSnapshot> {
    this.#snapshot = await this.#repository.save(
      this.#snapshot,
      this.session.toBundle()
    );
    return this.#snapshot;
  }

  dispose(): Promise<void> {
    return this.session.dispose();
  }
}

export async function openNodeProjectSession(
  options: OpenNodeProjectSessionOptions
): Promise<OpenNodeProjectSessionResult> {
  const repository = options.repository ?? new NodeProjectRepository();
  const read = await repository.read(options.projectPath);
  const diagnostics: Diagnostic[] = [...read.diagnostics];
  if (read.snapshot === undefined || hasErrorDiagnostics(diagnostics)) {
    return { diagnostics };
  }
  const opened = await ProjectSession.open({
    kineweaveVersion: options.kineweaveVersion,
    bundle: read.snapshot.bundle,
    distribution: options.distribution,
    host: options.host
  });
  diagnostics.push(...opened.diagnostics);
  if (opened.session === undefined || hasErrorDiagnostics(diagnostics)) {
    await opened.session?.dispose();
    return { diagnostics };
  }
  return {
    project: new NodeProjectSession(repository, read.snapshot, opened.session),
    diagnostics
  };
}
