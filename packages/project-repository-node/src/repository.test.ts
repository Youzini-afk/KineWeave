import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HistoryGraph } from "@kineweave/history-engine";
import {
  KINEWEAVE_PROTOCOL_VERSION,
  type JsonObject
} from "@kineweave/protocol";
import { NodeProjectRepository } from "./repository.js";
import type { LoadedProjectBundle } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "kineweave-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function bundle(text = "Hello"): LoadedProjectBundle {
  const document = {
    documentId: "document_main",
    documentType: "org.kineweave.standard-motion/composition",
    schemaVersion: 1,
    data: {
      headline: text,
      unknownExtensionData: {
        type: "org.example.future/fluid",
        viscosity: 0.72
      }
    }
  };
  return {
    manifest: {
      projectFormatVersion: 1,
      projectId: "project_demo",
      name: "Demo",
      entryDocumentId: "document_main",
      documents: {
        document_main: {
          documentType: "org.kineweave.standard-motion/composition",
          schemaVersion: 1,
          path: "documents/main.composition.json",
          futureDescriptorField: { preserved: true }
        }
      } as LoadedProjectBundle["manifest"]["documents"],
      extensionRequirements: {
        "org.kineweave.standard-motion": { versionRange: "^0.1.0" }
      },
      capabilityRequirements: {},
      outputProfiles: {},
      metadata: { futureManifestField: "preserved" }
    },
    lockfile: {
      lockfileFormatVersion: 1,
      projectId: "project_demo",
      protocolVersion: KINEWEAVE_PROTOCOL_VERSION,
      extensions: {
        "org.kineweave.standard-motion": {
          version: "0.1.0",
          source: { kind: "package", packageName: "standard-motion" }
        }
      },
      capabilityBindings: {},
      resources: {}
    },
    history: new HistoryGraph({
      document_main: document as unknown as JsonObject
    }).toSnapshot(),
    documents: {
      document_main: document
    }
  };
}

describe("NodeProjectRepository", () => {
  it("initializes, canonicalizes and reads an open-world project", async () => {
    const root = await temporaryDirectory();
    const repository = new NodeProjectRepository();
    const snapshot = await repository.initialize(root, bundle());

    expect(snapshot.bundle.documents.document_main?.data).toMatchObject({
      unknownExtensionData: { viscosity: 0.72 }
    });
    const manifest = await readFile(
      path.join(root, "kineweave.project.json"),
      "utf8"
    );
    expect(manifest.endsWith("\n")).toBe(true);
    expect(manifest.indexOf('"entryDocumentId"')).toBeLessThan(
      manifest.indexOf('"projectId"')
    );
  });

  it("saves atomically and preserves unknown data", async () => {
    const root = await temporaryDirectory();
    const repository = new NodeProjectRepository();
    const first = await repository.initialize(root, bundle());
    const next = bundle("Updated");

    const saved = await repository.save(first, next);
    expect(saved.bundle.documents.document_main?.data).toMatchObject({
      headline: "Updated",
      unknownExtensionData: { viscosity: 0.72 }
    });
  });

  it("detects concurrent file changes instead of overwriting them", async () => {
    const root = await temporaryDirectory();
    const repository = new NodeProjectRepository();
    const first = await repository.initialize(root, bundle());
    const documentPath = path.join(root, "documents", "main.composition.json");
    await writeFile(documentPath, '{"external":"change"}\n', "utf8");

    const next = bundle("Our update");
    await expect(repository.save(first, next)).rejects.toMatchObject({
      diagnostics: [
        expect.objectContaining({ code: "repository.save.failed" })
      ]
    });
    expect(await readFile(documentPath, "utf8")).toBe(
      '{"external":"change"}\n'
    );
  });

  it("rejects a save when materialized documents diverge from history", async () => {
    const root = await temporaryDirectory();
    const repository = new NodeProjectRepository();
    const first = await repository.initialize(root, bundle());
    const changed = bundle("Changed outside history");
    const inconsistent = { ...changed, history: first.bundle.history };

    await expect(repository.save(first, inconsistent)).rejects.toMatchObject({
      diagnostics: [
        expect.objectContaining({
          code: "repository.history.materialized-state-mismatch"
        })
      ]
    });
  });

  it("rolls back files already replaced when a later entry fails", async () => {
    const root = await temporaryDirectory();
    let appliedEntries = 0;
    const repository = new NodeProjectRepository({
      onTransactionEvent(event) {
        if (event.phase === "after-apply") {
          appliedEntries += 1;
          if (appliedEntries === 1) throw new Error("simulated power loss");
        }
      }
    });

    await expect(repository.initialize(root, bundle())).rejects.toThrow(
      /simulated power loss/
    );
    await expect(readFile(path.join(root, "kineweave.project.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});
