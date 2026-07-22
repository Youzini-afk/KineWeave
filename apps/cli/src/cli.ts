import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashJson } from "@kineweave/content-hash";
import {
  EvaluationRejectedError,
  type EvaluationExecutionResult
} from "@kineweave/evaluation-engine";
import {
  NodeProjectRepository,
  ProjectRepositoryError,
  type LoadedProjectBundle,
  type ProjectSnapshot
} from "@kineweave/project-repository-node";
import {
  createProjectResourceUri,
  hasErrorDiagnostics,
  rational,
  timeValue,
  STANDARD_TIME_DOMAINS,
  type Diagnostic,
  type EvaluationMode,
  type JsonObject,
  type JsonValue,
  type KineWeaveHistory,
  type Rational,
  type ProjectDocumentEnvelope,
  type TransactionProposal
} from "@kineweave/protocol";
import { RenderRejectedError } from "@kineweave/render-engine";
import {
  constant,
  createTextNode,
  STANDARD_COMPOSITION_TYPE,
  STANDARD_MOTION_OPERATIONS,
  type StandardCompositionDocument
} from "@kineweave/standard-motion-document";
import {
  BUILTIN_PRECONDITIONS,
  TransactionRejectedError
} from "@kineweave/transaction-engine";
import {
  bootstrapProjectRuntime,
  type ProjectRuntime
} from "./runtime.js";
import { createProjectTemplate } from "./template.js";

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text)
};

const HELP = `KineWeave CLI

Usage:
  kineweave init <project> [--name <name>]
  kineweave validate <project> [--json]
  kineweave inspect <project> [--json]
  kineweave evaluate <project> <documentId> <time> [--domain <id>] [--branch <name> | --commit <commitId>] [--width <px>] [--height <px>] [--pixel-ratio <rational>] [--color-space <id>] [--locale <tag>] [--seed <value>] [--mode <interactive|deterministic|live>] [--signals <jsonObject>] [--json]
  kineweave render <project> <documentId> <time> <outputPath> [evaluation options] [--profile <id>] [--provider <providerId>]
  kineweave history <project> [--json]
  kineweave undo <project> [--branch <name>]
  kineweave redo <project> [--branch <name>] [--commit <commitId>]
  kineweave branch list <project> [--json]
  kineweave branch create <project> <name> [--from <commitId>]
  kineweave branch delete <project> <name>
  kineweave set-property <project> <documentId> <nodeId> <property> <jsonValue> [--expect-hash <sha256:...>]
  kineweave insert-text <project> <documentId> <nodeId> <text> [--index <number>]
`;

function option(
  args: readonly string[],
  name: string
): { value: string | undefined; remaining: string[] } {
  const remaining = [...args];
  const index = remaining.indexOf(name);
  if (index === -1) return { value: undefined, remaining };
  const value = remaining[index + 1];
  if (value === undefined) throw new TypeError(`${name} requires a value`);
  remaining.splice(index, 2);
  return { value, remaining };
}

function flag(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

function rationalArgument(value: string, label: string): Rational {
  const match = /^(-?(?:0|[1-9][0-9]*))(?:\/([1-9][0-9]*))?$/.exec(value);
  if (match === null) {
    throw new TypeError(`${label} must be an integer or numerator/denominator`);
  }
  return rational(match[1]!, match[2] ?? "1");
}

function positiveIntegerArgument(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return parsed;
}

interface EvaluationCliOptions {
  readonly remaining: readonly string[];
  readonly json: boolean;
  readonly branchName?: string;
  readonly commitId?: string;
  readonly domain?: string;
  readonly width?: string;
  readonly height?: string;
  readonly pixelRatio?: string;
  readonly colorSpace?: string;
  readonly locale?: string;
  readonly seed?: string;
  readonly mode?: string;
  readonly signals?: string;
}

function evaluationCliOptions(args: readonly string[]): EvaluationCliOptions {
  const branch = option(args, "--branch");
  const commit = option(branch.remaining, "--commit");
  const domain = option(commit.remaining, "--domain");
  const width = option(domain.remaining, "--width");
  const height = option(width.remaining, "--height");
  const pixelRatio = option(height.remaining, "--pixel-ratio");
  const colorSpace = option(pixelRatio.remaining, "--color-space");
  const locale = option(colorSpace.remaining, "--locale");
  const seed = option(locale.remaining, "--seed");
  const mode = option(seed.remaining, "--mode");
  const signals = option(mode.remaining, "--signals");
  const json = flag(signals.remaining, "--json");
  if (branch.value !== undefined && commit.value !== undefined) {
    throw new TypeError("--branch and --commit are mutually exclusive");
  }
  return {
    remaining: signals.remaining.filter((item) => item !== "--json"),
    json,
    ...(branch.value === undefined ? {} : { branchName: branch.value }),
    ...(commit.value === undefined ? {} : { commitId: commit.value }),
    ...(domain.value === undefined ? {} : { domain: domain.value }),
    ...(width.value === undefined ? {} : { width: width.value }),
    ...(height.value === undefined ? {} : { height: height.value }),
    ...(pixelRatio.value === undefined
      ? {}
      : { pixelRatio: pixelRatio.value }),
    ...(colorSpace.value === undefined
      ? {}
      : { colorSpace: colorSpace.value }),
    ...(locale.value === undefined ? {} : { locale: locale.value }),
    ...(seed.value === undefined ? {} : { seed: seed.value }),
    ...(mode.value === undefined ? {} : { mode: mode.value }),
    ...(signals.value === undefined ? {} : { signals: signals.value })
  };
}

function diagnosticsText(diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .map((item) => {
      const location = [
        item.documentId,
        item.jsonPointer,
        item.resourceUri
      ]
        .filter((value) => value !== undefined)
        .join(":");
      return `${item.severity.toUpperCase()} ${item.code}${location ? ` (${location})` : ""}: ${item.message}`;
    })
    .join("\n");
}

function writeDiagnostics(
  io: CliIo,
  diagnostics: readonly Diagnostic[],
  json: boolean
): void {
  if (json) {
    io.stdout(`${JSON.stringify({ diagnostics }, null, 2)}\n`);
    return;
  }
  if (diagnostics.length > 0) io.stdout(`${diagnosticsText(diagnostics)}\n`);
}

async function openValidProject(
  repository: NodeProjectRepository,
  projectPath: string
): Promise<{ readonly snapshot: ProjectSnapshot; readonly runtime: ProjectRuntime }> {
  const result = await repository.read(projectPath);
  if (
    result.snapshot === undefined ||
    hasErrorDiagnostics(result.diagnostics)
  ) {
    throw new ProjectRepositoryError(
      "Project validation failed",
      result.diagnostics
    );
  }
  const bootstrap = await bootstrapProjectRuntime(result.snapshot);
  const diagnostics = [...result.diagnostics, ...bootstrap.diagnostics];
  if (hasErrorDiagnostics(diagnostics)) {
    await bootstrap.runtime.dispose();
    throw new ProjectRepositoryError("Project validation failed", diagnostics);
  }
  return { snapshot: result.snapshot, runtime: bootstrap.runtime };
}

async function evaluateRuntime(
  snapshot: ProjectSnapshot,
  runtime: ProjectRuntime,
  documentId: string,
  rawTime: string,
  options: EvaluationCliOptions
): Promise<{
  readonly result: EvaluationExecutionResult;
  readonly mode: EvaluationMode;
}> {
  const mode = options.mode ?? "deterministic";
  if (mode !== "interactive" && mode !== "deterministic" && mode !== "live") {
    throw new TypeError("--mode must be interactive, deterministic or live");
  }
  let externalSignals: Record<string, JsonValue> = {};
  if (options.signals !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(options.signals) as unknown;
    } catch (caught) {
      throw new TypeError(
        `--signals must be valid JSON: ${caught instanceof Error ? caught.message : String(caught)}`
      );
    }
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new TypeError("--signals must be a JSON object");
    }
    externalSignals = parsed as Record<string, JsonValue>;
  }

  const document = snapshot.bundle.documents[documentId];
  const standardComposition =
    document?.documentType === STANDARD_COMPOSITION_TYPE
      ? (document as StandardCompositionDocument)
      : undefined;
  const width =
    options.width === undefined
      ? (standardComposition?.data.canvas.width ?? 1920)
      : positiveIntegerArgument(options.width, "--width");
  const height =
    options.height === undefined
      ? (standardComposition?.data.canvas.height ?? 1080)
      : positiveIntegerArgument(options.height, "--height");
  const result = await runtime.evaluation.evaluate({
    documentId,
    ...(options.branchName === undefined
      ? options.commitId === undefined
        ? {}
        : { state: { kind: "commit" as const, commitId: options.commitId } }
      : { state: { kind: "branch" as const, branchName: options.branchName } }),
    time: timeValue(
      rationalArgument(rawTime, "time"),
      options.domain ?? STANDARD_TIME_DOMAINS.seconds
    ),
    mode,
    viewport: {
      width,
      height,
      pixelRatio:
        options.pixelRatio === undefined
          ? rational(1)
          : rationalArgument(options.pixelRatio, "--pixel-ratio")
    },
    colorSpace:
      options.colorSpace ??
      standardComposition?.data.canvas.colorSpace ??
      "org.kineweave.color/srgb",
    locale: options.locale ?? "en-US",
    randomSeed: options.seed ?? "cli-deterministic",
    externalSignals
  });
  return { result, mode };
}

function nextBundle(
  snapshot: ProjectSnapshot,
  state: Readonly<Record<string, JsonValue>>,
  history: KineWeaveHistory
): LoadedProjectBundle {
  return {
    ...snapshot.bundle,
    history,
    documents: Object.fromEntries(
      Object.entries(state).map(([documentId, document]) => [
        documentId,
        document as unknown as ProjectDocumentEnvelope<JsonObject>
      ])
    )
  };
}

async function persistRuntime(
  repository: NodeProjectRepository,
  snapshot: ProjectSnapshot,
  runtime: ProjectRuntime
): Promise<void> {
  await repository.save(
    snapshot,
    nextBundle(
      snapshot,
      runtime.history.stateOfBranch(runtime.history.mainBranchName),
      runtime.history.toSnapshot()
    )
  );
}

function operationProposal(
  operationType: string,
  targets: readonly string[],
  payload: JsonObject,
  preconditions?: TransactionProposal["operations"][number]["preconditions"]
): TransactionProposal {
  const transactionId = `transaction_${randomUUID().replaceAll("-", "")}`;
  return {
    transactionId,
    branchName: "main",
    origin: { kind: "user", actorId: "cli-local" },
    operations: [
      {
        operationId: `operation_${randomUUID().replaceAll("-", "")}`,
        operationType,
        schemaVersion: 1,
        targets,
        payload,
        ...(preconditions === undefined ? {} : { preconditions })
      }
    ]
  };
}

async function initCommand(args: readonly string[], io: CliIo): Promise<number> {
  const nameOption = option(args, "--name");
  const [projectPath, ...extra] = nameOption.remaining;
  if (projectPath === undefined || extra.length > 0) throw new TypeError(HELP);
  const name = nameOption.value ?? path.basename(path.resolve(projectPath));
  const repository = new NodeProjectRepository();
  const snapshot = await repository.initialize(
    projectPath,
    createProjectTemplate({ name })
  );
  io.stdout(
    `Initialized ${snapshot.bundle.manifest.name} at ${snapshot.rootPath}\n`
  );
  return 0;
}

async function validateCommand(
  args: readonly string[],
  io: CliIo
): Promise<number> {
  const json = flag(args, "--json");
  const positional = args.filter((item) => item !== "--json");
  if (positional.length !== 1) throw new TypeError(HELP);
  const repository = new NodeProjectRepository();
  const result = await repository.read(positional[0]!);
  const diagnostics: Diagnostic[] = [...result.diagnostics];
  let runtime: ProjectRuntime | undefined;
  try {
    if (
      result.snapshot !== undefined &&
      !hasErrorDiagnostics(result.diagnostics)
    ) {
      const bootstrap = await bootstrapProjectRuntime(result.snapshot);
      runtime = bootstrap.runtime;
      diagnostics.push(...bootstrap.diagnostics);
    }
    writeDiagnostics(io, diagnostics, json);
    if (!hasErrorDiagnostics(diagnostics)) {
      if (!json) io.stdout("Project is valid.\n");
      return 0;
    }
    return 1;
  } finally {
    await runtime?.dispose();
  }
}

async function inspectCommand(
  args: readonly string[],
  io: CliIo
): Promise<number> {
  const json = flag(args, "--json");
  const positional = args.filter((item) => item !== "--json");
  if (positional.length !== 1) throw new TypeError(HELP);
  const repository = new NodeProjectRepository();
  const { snapshot, runtime } = await openValidProject(
    repository,
    positional[0]!
  );
  try {
    const documents = Object.entries(snapshot.bundle.documents).map(
      ([documentId, document]) => {
        const descriptor = snapshot.bundle.manifest.documents[documentId]!;
        const base = {
          documentId,
          documentType: document.documentType,
          schemaVersion: document.schemaVersion,
          path: descriptor.path,
          contentHash: hashJson(document as unknown as JsonObject)
        };
        return document.documentType === STANDARD_COMPOSITION_TYPE
          ? {
              ...base,
              name: (document as StandardCompositionDocument).data.name,
              nodeCount: Object.keys(
                (document as StandardCompositionDocument).data.nodes
              ).length,
              trackCount: Object.keys(
                (document as StandardCompositionDocument).data.tracks
              ).length
            }
          : base;
      }
    );
    const summary = {
      projectId: snapshot.bundle.manifest.projectId,
      name: snapshot.bundle.manifest.name,
      entryDocumentId: snapshot.bundle.manifest.entryDocumentId,
      documents
    };
    if (json) io.stdout(`${JSON.stringify(summary, null, 2)}\n`);
    else {
      io.stdout(`${summary.name} (${summary.projectId})\n`);
      for (const document of documents) {
        io.stdout(
          `- ${document.documentId}: ${document.documentType}@${document.schemaVersion} ${document.contentHash}\n`
        );
      }
    }
    return 0;
  } finally {
    await runtime.dispose();
  }
}

async function historyCommand(
  args: readonly string[],
  io: CliIo
): Promise<number> {
  const json = flag(args, "--json");
  const positional = args.filter((item) => item !== "--json");
  if (positional.length !== 1) throw new TypeError(HELP);
  const repository = new NodeProjectRepository();
  const { runtime } = await openValidProject(repository, positional[0]!);
  try {
    const persisted = runtime.history.toSnapshot();
    const summary = {
      rootCommitId: persisted.rootCommitId,
      mainBranchName: persisted.mainBranchName,
      branches: runtime.history.listBranches(),
      commits: Object.values(persisted.commits)
        .sort((left, right) =>
          left.committedAt === right.committedAt
            ? left.commitId.localeCompare(right.commitId)
            : left.committedAt.localeCompare(right.committedAt)
        )
        .map((commit) => ({
          commitId: commit.commitId,
          parentCommitIds: commit.parentCommitIds,
          transactionId: commit.transaction.transactionId,
          branchName: commit.transaction.branchName,
          origin: commit.transaction.origin,
          committedAt: commit.committedAt,
          operationTypes: commit.transaction.operations.map(
            (operation) => operation.operationType
          )
        }))
    };
    if (json) io.stdout(`${JSON.stringify(summary, null, 2)}\n`);
    else {
      for (const branch of summary.branches) {
        io.stdout(`* ${branch.name} -> ${branch.headCommitId}\n`);
      }
      for (const commit of summary.commits) {
        io.stdout(
          `- ${commit.commitId} ${commit.transactionId} (${commit.origin.kind})\n`
        );
      }
    }
    return 0;
  } finally {
    await runtime.dispose();
  }
}

async function evaluateCommand(
  args: readonly string[],
  io: CliIo
): Promise<number> {
  const options = evaluationCliOptions(args);
  const [projectPath, documentId, rawTime, ...extra] = options.remaining;
  if (
    projectPath === undefined ||
    documentId === undefined ||
    rawTime === undefined ||
    extra.length > 0
  ) {
    throw new TypeError(HELP);
  }

  const repository = new NodeProjectRepository();
  const { snapshot, runtime } = await openValidProject(repository, projectPath);
  try {
    const { result } = await evaluateRuntime(
      snapshot,
      runtime,
      documentId,
      rawTime,
      options
    );
    if (options.json) io.stdout(`${JSON.stringify(result.graph, null, 2)}\n`);
    else {
      io.stdout(
        `Evaluated ${documentId} at ${result.graph.time.value.numerator}/${result.graph.time.value.denominator} ${result.graph.time.domain}.\n`
      );
      io.stdout(
        `${Object.keys(result.graph.nodes).length} presentation nodes; features: ${result.graph.requiredFeatures.join(", ") || "none"}.\n`
      );
      writeDiagnostics(io, result.diagnostics, false);
    }
    return 0;
  } finally {
    await runtime.dispose();
  }
}

async function renderCommand(
  args: readonly string[],
  io: CliIo
): Promise<number> {
  const profileOption = option(args, "--profile");
  const providerOption = option(profileOption.remaining, "--provider");
  const options = evaluationCliOptions(providerOption.remaining);
  const [projectPath, documentId, rawTime, outputPath, ...extra] =
    options.remaining;
  if (
    projectPath === undefined ||
    documentId === undefined ||
    rawTime === undefined ||
    outputPath === undefined ||
    extra.length > 0
  ) {
    throw new TypeError(HELP);
  }

  const repository = new NodeProjectRepository();
  const { snapshot, runtime } = await openValidProject(repository, projectPath);
  try {
    const { result: evaluation, mode } = await evaluateRuntime(
      snapshot,
      runtime,
      documentId,
      rawTime,
      options
    );
    const profileId =
      profileOption.value ??
      (snapshot.bundle.manifest.outputProfiles.svg === undefined
        ? undefined
        : "svg");
    const profile =
      profileId === undefined
        ? undefined
        : snapshot.bundle.manifest.outputProfiles[profileId];
    if (profileOption.value !== undefined && profile === undefined) {
      throw new TypeError(`Unknown output profile ${profileOption.value}`);
    }
    const rendered = await runtime.rendering.render({
      graph: evaluation.graph,
      evaluationMode: mode,
      settings: profile?.settings ?? {},
      ...(providerOption.value === undefined
        ? {}
        : { preferredProviderIds: [providerOption.value] })
    });
    const absoluteOutputPath = path.resolve(outputPath);
    if (
      path.extname(absoluteOutputPath).toLowerCase() !==
      rendered.artifact.fileExtension.toLowerCase()
    ) {
      throw new TypeError(
        `Output path must end with ${rendered.artifact.fileExtension} for ${rendered.artifact.mediaType}`
      );
    }
    await mkdir(path.dirname(absoluteOutputPath), { recursive: true });
    await writeFile(absoluteOutputPath, rendered.artifact.text, "utf8");
    if (options.json) {
      io.stdout(
        `${JSON.stringify(
          {
            outputPath: absoluteOutputPath,
            mediaType: rendered.artifact.mediaType,
            rendererProviderId: rendered.provider.providerId,
            presentationNodeCount: Object.keys(evaluation.graph.nodes).length
          },
          null,
          2
        )}\n`
      );
    } else {
      io.stdout(
        `Rendered ${documentId} with ${rendered.provider.providerId} to ${absoluteOutputPath}.\n`
      );
    }
    return 0;
  } finally {
    await runtime.dispose();
  }
}

async function undoCommand(
  args: readonly string[],
  io: CliIo
): Promise<number> {
  const branchOption = option(args, "--branch");
  const [projectPath, ...extra] = branchOption.remaining;
  if (projectPath === undefined || extra.length > 0) throw new TypeError(HELP);
  const branchName = branchOption.value ?? "main";
  const repository = new NodeProjectRepository();
  const { snapshot, runtime } = await openValidProject(repository, projectPath);
  try {
    const branch = runtime.history.undo(branchName);
    if (branch === undefined) {
      io.stdout(`Nothing to undo on ${branchName}.\n`);
      return 0;
    }
    await persistRuntime(repository, snapshot, runtime);
    io.stdout(`Moved ${branch.name} to ${branch.headCommitId}.\n`);
    return 0;
  } finally {
    await runtime.dispose();
  }
}

async function redoCommand(
  args: readonly string[],
  io: CliIo
): Promise<number> {
  const branchOption = option(args, "--branch");
  const commitOption = option(branchOption.remaining, "--commit");
  const [projectPath, ...extra] = commitOption.remaining;
  if (projectPath === undefined || extra.length > 0) throw new TypeError(HELP);
  const branchName = branchOption.value ?? "main";
  const repository = new NodeProjectRepository();
  const { snapshot, runtime } = await openValidProject(repository, projectPath);
  try {
    const branch = runtime.history.redo(branchName, commitOption.value);
    if (branch === undefined) {
      io.stdout(`Nothing to redo on ${branchName}.\n`);
      return 0;
    }
    await persistRuntime(repository, snapshot, runtime);
    io.stdout(`Moved ${branch.name} to ${branch.headCommitId}.\n`);
    return 0;
  } finally {
    await runtime.dispose();
  }
}

async function branchCommand(
  args: readonly string[],
  io: CliIo
): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "list") {
    const json = flag(rest, "--json");
    const positional = rest.filter((item) => item !== "--json");
    if (positional.length !== 1) throw new TypeError(HELP);
    const repository = new NodeProjectRepository();
    const { runtime } = await openValidProject(repository, positional[0]!);
    try {
      const branches = runtime.history.listBranches();
      if (json) io.stdout(`${JSON.stringify({ branches }, null, 2)}\n`);
      else {
        for (const branch of branches) {
          io.stdout(`${branch.name} -> ${branch.headCommitId}\n`);
        }
      }
      return 0;
    } finally {
      await runtime.dispose();
    }
  }

  if (subcommand === "create") {
    const fromOption = option(rest, "--from");
    const [projectPath, branchName, ...extra] = fromOption.remaining;
    if (
      projectPath === undefined ||
      branchName === undefined ||
      extra.length > 0
    ) {
      throw new TypeError(HELP);
    }
    const repository = new NodeProjectRepository();
    const { snapshot, runtime } = await openValidProject(repository, projectPath);
    try {
      const branch = runtime.history.createBranch(branchName, fromOption.value);
      await persistRuntime(repository, snapshot, runtime);
      io.stdout(`Created ${branch.name} at ${branch.headCommitId}.\n`);
      return 0;
    } finally {
      await runtime.dispose();
    }
  }

  if (subcommand === "delete") {
    const [projectPath, branchName, ...extra] = rest;
    if (
      projectPath === undefined ||
      branchName === undefined ||
      extra.length > 0
    ) {
      throw new TypeError(HELP);
    }
    const repository = new NodeProjectRepository();
    const { snapshot, runtime } = await openValidProject(repository, projectPath);
    try {
      runtime.history.deleteBranch(branchName);
      await persistRuntime(repository, snapshot, runtime);
      io.stdout(`Deleted ${branchName}.\n`);
      return 0;
    } finally {
      await runtime.dispose();
    }
  }

  throw new TypeError(HELP);
}

async function setPropertyCommand(
  args: readonly string[],
  io: CliIo
): Promise<number> {
  const expectedHashOption = option(args, "--expect-hash");
  const [projectPath, documentId, nodeId, property, rawValue, ...extra] =
    expectedHashOption.remaining;
  if (
    projectPath === undefined ||
    documentId === undefined ||
    nodeId === undefined ||
    property === undefined ||
    rawValue === undefined ||
    extra.length > 0
  ) {
    throw new TypeError(HELP);
  }
  let value: JsonValue;
  try {
    value = JSON.parse(rawValue) as JsonValue;
  } catch (error) {
    throw new TypeError(
      `jsonValue must be valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const repository = new NodeProjectRepository();
  const { snapshot, runtime } = await openValidProject(repository, projectPath);
  try {
    const preconditions =
      expectedHashOption.value === undefined
        ? undefined
        : [
            {
              type: BUILTIN_PRECONDITIONS.documentHash,
              schemaVersion: 1,
              payload: { documentId, expectedHash: expectedHashOption.value }
            }
          ];
    const result = await runtime.engine.execute(
      operationProposal(
        STANDARD_MOTION_OPERATIONS.setProperty,
        [
          createProjectResourceUri("document", documentId, ["node", nodeId])
        ],
        {
          documentId,
          nodeId,
          property,
          binding: constant(value)
        },
        preconditions
      )
    );
    await persistRuntime(repository, snapshot, runtime);
    io.stdout(
      `Committed ${result.commit.commitId}; updated ${documentId}/${nodeId}.${property}\n`
    );
    return 0;
  } finally {
    await runtime.dispose();
  }
}

async function insertTextCommand(
  args: readonly string[],
  io: CliIo
): Promise<number> {
  const indexOption = option(args, "--index");
  const [projectPath, documentId, nodeId, text, ...extra] =
    indexOption.remaining;
  if (
    projectPath === undefined ||
    documentId === undefined ||
    nodeId === undefined ||
    text === undefined ||
    extra.length > 0
  ) {
    throw new TypeError(HELP);
  }
  const index = indexOption.value === undefined ? 1 : Number(indexOption.value);
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new TypeError("--index must be a non-negative integer");
  }

  const repository = new NodeProjectRepository();
  const { snapshot, runtime } = await openValidProject(repository, projectPath);
  try {
    const result = await runtime.engine.execute(
      operationProposal(
        STANDARD_MOTION_OPERATIONS.insertNode,
        [createProjectResourceUri("document", documentId)],
        {
          documentId,
          parentNodeId: null,
          index,
          node: createTextNode(nodeId, text)
        }
      )
    );
    await persistRuntime(repository, snapshot, runtime);
    io.stdout(`Committed ${result.commit.commitId}; inserted ${nodeId}\n`);
    return 0;
  } finally {
    await runtime.dispose();
  }
}

export async function runCli(
  argv: readonly string[],
  io: CliIo = defaultIo
): Promise<number> {
  const [command, ...args] = argv;
  if (command === undefined || command === "help" || command === "--help") {
    io.stdout(HELP);
    return 0;
  }

  try {
    switch (command) {
      case "init":
        return await initCommand(args, io);
      case "validate":
        return await validateCommand(args, io);
      case "inspect":
        return await inspectCommand(args, io);
      case "evaluate":
        return await evaluateCommand(args, io);
      case "render":
        return await renderCommand(args, io);
      case "history":
        return await historyCommand(args, io);
      case "undo":
        return await undoCommand(args, io);
      case "redo":
        return await redoCommand(args, io);
      case "branch":
        return await branchCommand(args, io);
      case "set-property":
        return await setPropertyCommand(args, io);
      case "insert-text":
        return await insertTextCommand(args, io);
      default:
        throw new TypeError(`Unknown command ${command}\n\n${HELP}`);
    }
  } catch (error) {
    if (
      error instanceof ProjectRepositoryError ||
      error instanceof TransactionRejectedError ||
      error instanceof EvaluationRejectedError ||
      error instanceof RenderRejectedError
    ) {
      io.stderr(`${diagnosticsText(error.diagnostics)}\n`);
      return 1;
    }
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof TypeError ? 2 : 1;
  }
}
