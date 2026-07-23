import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { HistoryGraph } from "@kineweave/history-engine";
import { canonicalStringify, validateProjectBundle } from "@kineweave/project-format";
import {
  type Diagnostic,
  hasErrorDiagnostics,
  type JsonObject,
  type KineWeaveHistory,
  type KineWeaveLockfile,
  type KineWeaveProjectManifest,
  type ProjectDocumentEnvelope
} from "@kineweave/protocol";
import { ProjectRepositoryError } from "./errors.js";
import { sha256 } from "./hash.js";
import { applyFileTransaction, recoverFileTransactions, type WriteIntent } from "./journal.js";
import { resolveSafeProjectPath } from "./safe-path.js";
import type {
  LoadedProjectBundle,
  NodeProjectRepositoryOptions,
  ProjectReadResult,
  ProjectSnapshot,
  RecoveryReport
} from "./types.js";

const MANIFEST_PATH = "kineweave.project.json";
const LOCKFILE_PATH = "kineweave.lock.json";
const HISTORY_PATH = ".kineweave/history/history.json";

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function diagnostic(code: string, message: string, resourceUri?: string): Diagnostic {
  return {
    severity: "error",
    code,
    message,
    ...(resourceUri === undefined ? {} : { resourceUri }),
    source: "@kineweave/project-repository-node"
  };
}

async function readJson(
  filePath: string,
  relativePath: string,
  fileHashes: Record<string, string>,
  diagnostics: Diagnostic[]
): Promise<unknown | undefined> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    diagnostics.push(
      diagnostic(
        isMissing(error) ? "repository.file.missing" : "repository.file.read-failed",
        isMissing(error)
          ? `Required project file is missing: ${relativePath}`
          : `Cannot read ${relativePath}: ${error instanceof Error ? error.message : String(error)}`
      )
    );
    return undefined;
  }

  fileHashes[relativePath] = sha256(content);
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    diagnostics.push(
      diagnostic(
        "repository.json.invalid",
        `Invalid JSON in ${relativePath}: ${error instanceof Error ? error.message : String(error)}`
      )
    );
    return undefined;
  }
}

function bundleFiles(bundle: LoadedProjectBundle): Readonly<Record<string, string>> {
  const files: Record<string, string> = {
    [MANIFEST_PATH]: canonicalStringify(bundle.manifest as unknown as JsonObject),
    [LOCKFILE_PATH]: canonicalStringify(bundle.lockfile as unknown as JsonObject),
    [HISTORY_PATH]: canonicalStringify(bundle.history as unknown as JsonObject)
  };
  for (const [documentId, descriptor] of Object.entries(bundle.manifest.documents)) {
    const document = bundle.documents[documentId];
    if (document !== undefined) {
      files[descriptor.path] = canonicalStringify(document as unknown as JsonObject);
    }
  }
  return files;
}

function validateHistoryState(bundle: LoadedProjectBundle): readonly Diagnostic[] {
  let history: HistoryGraph;
  try {
    history = HistoryGraph.fromSnapshot(bundle.history);
  } catch (error) {
    return [
      diagnostic(
        "repository.history.invalid",
        error instanceof Error ? error.message : String(error)
      )
    ];
  }

  const materialized = canonicalStringify(
    history.stateOfBranch(history.mainBranchName) as unknown as JsonObject
  );
  const documents = canonicalStringify(bundle.documents as unknown as JsonObject);
  return materialized === documents
    ? []
    : [
        diagnostic(
          "repository.history.materialized-state-mismatch",
          "Materialized project documents do not match the persisted main history branch"
        )
      ];
}

function validateLoadedBundle(bundle: LoadedProjectBundle): readonly Diagnostic[] {
  const diagnostics = [...validateProjectBundle(bundle)];
  if (!hasErrorDiagnostics(diagnostics)) {
    diagnostics.push(...validateHistoryState(bundle));
  }
  return diagnostics;
}

export class NodeProjectRepository {
  constructor(readonly options: NodeProjectRepositoryOptions = {}) {}

  async recover(rootPath: string): Promise<RecoveryReport> {
    return recoverFileTransactions(path.resolve(rootPath));
  }

  async read(rootPath: string): Promise<ProjectReadResult> {
    const root = path.resolve(rootPath);
    const diagnostics: Diagnostic[] = [];
    const fileHashes: Record<string, string> = {};

    try {
      await stat(root);
    } catch (_error) {
      return {
        diagnostics: [
          diagnostic("repository.root.missing", `Project directory does not exist: ${root}`)
        ]
      };
    }

    const recovery = await this.recover(root);
    diagnostics.push(...recovery.diagnostics);
    if (hasErrorDiagnostics(diagnostics)) return { diagnostics };

    const manifestRaw = await readJson(
      path.join(root, MANIFEST_PATH),
      MANIFEST_PATH,
      fileHashes,
      diagnostics
    );
    const lockfileRaw = await readJson(
      path.join(root, LOCKFILE_PATH),
      LOCKFILE_PATH,
      fileHashes,
      diagnostics
    );
    let historyPath: string;
    try {
      historyPath = await resolveSafeProjectPath(root, HISTORY_PATH);
    } catch (error) {
      diagnostics.push(
        diagnostic(
          "repository.history.path-unsafe",
          error instanceof Error ? error.message : String(error)
        )
      );
      return { diagnostics };
    }
    const historyRaw = await readJson(historyPath, HISTORY_PATH, fileHashes, diagnostics);
    if (manifestRaw === undefined || lockfileRaw === undefined || historyRaw === undefined) {
      return { diagnostics };
    }

    const shallowDiagnostics = validateProjectBundle({
      manifest: manifestRaw,
      lockfile: lockfileRaw,
      history: historyRaw,
      documents: {}
    }).filter((item) => item.code !== "project.document.missing");
    diagnostics.push(...shallowDiagnostics);
    if (hasErrorDiagnostics(shallowDiagnostics)) return { diagnostics };

    const manifest = manifestRaw as KineWeaveProjectManifest;
    const documents: Record<string, ProjectDocumentEnvelope<JsonObject>> = {};

    for (const [documentId, descriptor] of Object.entries(manifest.documents)) {
      let filePath: string;
      try {
        filePath = await resolveSafeProjectPath(root, descriptor.path);
      } catch (error) {
        diagnostics.push(
          diagnostic(
            "repository.document.path-unsafe",
            error instanceof Error ? error.message : String(error)
          )
        );
        continue;
      }
      const raw = await readJson(filePath, descriptor.path, fileHashes, diagnostics);
      if (raw !== undefined) {
        documents[documentId] = raw as ProjectDocumentEnvelope<JsonObject>;
      }
    }

    const bundle = {
      manifest,
      lockfile: lockfileRaw as KineWeaveLockfile,
      history: historyRaw as KineWeaveHistory,
      documents
    };
    diagnostics.push(...validateLoadedBundle(bundle));
    if (hasErrorDiagnostics(diagnostics)) return { diagnostics };

    return {
      snapshot: {
        rootPath: root,
        bundle,
        fileHashes
      },
      diagnostics
    };
  }

  async initialize(rootPath: string, bundle: LoadedProjectBundle): Promise<ProjectSnapshot> {
    const root = path.resolve(rootPath);
    await mkdir(root, { recursive: true });
    const entries = await readdir(root);
    if (entries.length > 0) {
      throw new ProjectRepositoryError(`Cannot initialize non-empty directory ${root}`, [
        diagnostic("repository.initialize.not-empty", `Directory is not empty: ${root}`)
      ]);
    }

    const validation = validateLoadedBundle(bundle);
    if (hasErrorDiagnostics(validation)) {
      throw new ProjectRepositoryError("Cannot initialize an invalid project", validation);
    }

    const files = bundleFiles(bundle);
    const intents: WriteIntent[] = Object.entries(files).map(([relativePath, content]) => ({
      relativePath,
      content,
      expectedHash: null
    }));
    await applyFileTransaction(root, intents, this.options);
    const result = await this.read(root);
    if (result.snapshot === undefined) {
      throw new ProjectRepositoryError(
        "Initialized project could not be read back",
        result.diagnostics
      );
    }
    return result.snapshot;
  }

  async save(previous: ProjectSnapshot, nextBundle: LoadedProjectBundle): Promise<ProjectSnapshot> {
    const validation = validateLoadedBundle(nextBundle);
    if (hasErrorDiagnostics(validation)) {
      throw new ProjectRepositoryError("Cannot save an invalid project", validation);
    }

    const previousFiles = bundleFiles(previous.bundle);
    const nextFiles = bundleFiles(nextBundle);
    const allPaths = new Set([...Object.keys(previousFiles), ...Object.keys(nextFiles)]);
    const intents: WriteIntent[] = [];

    for (const relativePath of [...allPaths].sort()) {
      const previousContent = previousFiles[relativePath];
      const nextContent = nextFiles[relativePath];
      if (previousContent === nextContent) continue;
      intents.push({
        relativePath,
        content: nextContent ?? null,
        expectedHash: previous.fileHashes[relativePath] ?? null
      });
    }

    if (intents.length > 0) {
      try {
        await applyFileTransaction(previous.rootPath, intents, this.options);
      } catch (error) {
        throw new ProjectRepositoryError(
          `Project save failed: ${error instanceof Error ? error.message : String(error)}`,
          [
            diagnostic(
              "repository.save.failed",
              error instanceof Error ? error.message : String(error)
            )
          ]
        );
      }
    }

    const result = await this.read(previous.rootPath);
    if (result.snapshot === undefined) {
      throw new ProjectRepositoryError("Saved project could not be read back", result.diagnostics);
    }
    return result.snapshot;
  }
}
