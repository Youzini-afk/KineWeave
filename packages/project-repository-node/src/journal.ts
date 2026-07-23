import { randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { canonicalStringify } from "@kineweave/project-format";
import type { JsonObject } from "@kineweave/protocol";
import { sha256 } from "./hash.js";
import type {
  NodeProjectRepositoryOptions,
  RecoveryReport,
  RepositoryTransactionEvent
} from "./types.js";

interface WriteIntent {
  readonly relativePath: string;
  readonly content: string | null;
  readonly expectedHash: string | null;
}

interface JournalEntry extends JsonObject {
  readonly relativePath: string;
  readonly stagedPath: string | null;
  readonly backupPath: string | null;
  readonly expectedHash: string | null;
  readonly afterHash: string | null;
  readonly existedBefore: boolean;
}

interface JournalFile extends JsonObject {
  readonly transactionId: string;
  readonly state: "prepared" | "applying" | "committed" | "rolled-back";
  readonly entries: JournalEntry[];
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

async function existingHash(filePath: string): Promise<string | null> {
  try {
    return sha256(await readFile(filePath));
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function durableWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const handle = await open(filePath, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceFile(source: string, target: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await rename(source, target);
  } catch (error) {
    const code =
      error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: string }).code
        : undefined;
    if (code !== "EEXIST" && code !== "EPERM") throw error;
    await unlink(target).catch((unlinkError: unknown) => {
      if (!isMissing(unlinkError)) throw unlinkError;
    });
    await rename(source, target);
  }
}

async function notify(
  options: NodeProjectRepositoryOptions,
  event: RepositoryTransactionEvent
): Promise<void> {
  await options.onTransactionEvent?.(event);
}

export async function applyFileTransaction(
  rootPath: string,
  intents: readonly WriteIntent[],
  options: NodeProjectRepositoryOptions
): Promise<string> {
  const transactionId = `txn_${randomUUID().replaceAll("-", "")}`;
  const transactionRoot = path.join(rootPath, ".kineweave", "transactions", transactionId);
  const stageRoot = path.join(transactionRoot, "stage");
  const backupRoot = path.join(transactionRoot, "backup");
  const journalPath = path.join(transactionRoot, "journal.json");
  await mkdir(stageRoot, { recursive: true });
  await mkdir(backupRoot, { recursive: true });

  const entries: JournalEntry[] = [];
  for (const [index, intent] of intents.entries()) {
    const targetPath = path.join(rootPath, ...intent.relativePath.split("/"));
    const actualHash = await existingHash(targetPath);
    if (actualHash !== intent.expectedHash) {
      throw new Error(
        `Concurrent file change for ${intent.relativePath}: expected ${intent.expectedHash ?? "missing"}, got ${actualHash ?? "missing"}`
      );
    }

    let stagedPath: string | null = null;
    if (intent.content !== null) {
      stagedPath = path.join(stageRoot, `${index}.json`);
      await durableWrite(stagedPath, intent.content);
    }

    const backupPath = actualHash === null ? null : path.join(backupRoot, `${index}.bak`);
    if (backupPath !== null) {
      await copyFile(targetPath, backupPath);
    }

    entries.push({
      relativePath: intent.relativePath,
      stagedPath,
      backupPath,
      expectedHash: intent.expectedHash,
      afterHash: intent.content === null ? null : sha256(intent.content),
      existedBefore: actualHash !== null
    });
  }

  let journal: JournalFile = {
    transactionId,
    state: "prepared",
    entries
  };
  await durableWrite(journalPath, canonicalStringify(journal));
  await notify(options, { transactionId, phase: "prepared" });

  const applied: JournalEntry[] = [];
  try {
    journal = { ...journal, state: "applying" };
    await durableWrite(journalPath, canonicalStringify(journal));

    for (const [entryIndex, entry] of entries.entries()) {
      await notify(options, {
        transactionId,
        phase: "before-apply",
        relativePath: entry.relativePath,
        entryIndex
      });
      const targetPath = path.join(rootPath, ...entry.relativePath.split("/"));
      if (entry.stagedPath === null) {
        await unlink(targetPath).catch((error: unknown) => {
          if (!isMissing(error)) throw error;
        });
      } else {
        await replaceFile(entry.stagedPath, targetPath);
      }
      applied.push(entry);
      await notify(options, {
        transactionId,
        phase: "after-apply",
        relativePath: entry.relativePath,
        entryIndex
      });
    }

    journal = { ...journal, state: "committed" };
    await durableWrite(journalPath, canonicalStringify(journal));
    await notify(options, { transactionId, phase: "committed" });
    await rm(transactionRoot, { recursive: true, force: true });
    return transactionId;
  } catch (error) {
    await rollbackEntries(rootPath, [...applied].reverse());
    journal = { ...journal, state: "rolled-back" };
    await durableWrite(journalPath, canonicalStringify(journal)).catch(() => {});
    await notify(options, { transactionId, phase: "rolled-back" }).catch(() => {});
    throw error;
  }
}

async function rollbackEntries(rootPath: string, entries: readonly JournalEntry[]): Promise<void> {
  for (const entry of entries) {
    const targetPath = path.join(rootPath, ...entry.relativePath.split("/"));
    if (entry.backupPath === null) {
      await unlink(targetPath).catch((error: unknown) => {
        if (!isMissing(error)) throw error;
      });
    } else {
      const restoreTemp = `${targetPath}.restore-${randomUUID()}`;
      await mkdir(path.dirname(targetPath), { recursive: true });
      await copyFile(entry.backupPath, restoreTemp);
      await replaceFile(restoreTemp, targetPath);
    }
  }
}

export async function recoverFileTransactions(rootPath: string): Promise<RecoveryReport> {
  const transactionsRoot = path.join(rootPath, ".kineweave", "transactions");
  let transactionNames: string[];
  try {
    const { readdir } = await import("node:fs/promises");
    transactionNames = await readdir(transactionsRoot);
  } catch (error) {
    if (isMissing(error)) {
      return { recoveredTransactions: [], diagnostics: [] };
    }
    throw error;
  }

  const recoveredTransactions: string[] = [];
  const diagnostics: import("@kineweave/protocol").Diagnostic[] = [];

  for (const transactionName of transactionNames.sort()) {
    const transactionRoot = path.join(transactionsRoot, transactionName);
    const journalPath = path.join(transactionRoot, "journal.json");
    try {
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as JournalFile;
      if (journal.state === "committed" || journal.state === "rolled-back") {
        await rm(transactionRoot, { recursive: true, force: true });
        continue;
      }
      await rollbackEntries(rootPath, [...journal.entries].reverse());
      await rm(transactionRoot, { recursive: true, force: true });
      recoveredTransactions.push(journal.transactionId);
    } catch (error) {
      diagnostics.push({
        severity: "error",
        code: "repository.recovery.failed",
        message: error instanceof Error ? error.message : String(error),
        source: "@kineweave/project-repository-node",
        details: { transactionName }
      });
    }
  }

  return { recoveredTransactions, diagnostics };
}

export type { WriteIntent };
