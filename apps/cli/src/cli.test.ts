import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "./cli.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function temporaryProjectPath(): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), "kineweave-cli-"));
  temporaryDirectories.push(parent);
  return path.join(parent, "project");
}

function captureIo() {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    }
  };
  return {
    io,
    output: () => ({ stdout, stderr })
  };
}

describe("KineWeave CLI", () => {
  it("runs init, validate, inspect and transactional edits end to end", async () => {
    const projectPath = await temporaryProjectPath();
    const capture = captureIo();

    expect(
      await runCli(["init", projectPath, "--name", "CLI Demo"], capture.io)
    ).toBe(0);
    expect(await runCli(["validate", projectPath], capture.io)).toBe(0);
    expect(
      await runCli(
        [
          "set-property",
          projectPath,
          "document_main",
          "node_headline",
          "content",
          '"你好，织时"'
        ],
        capture.io
      )
    ).toBe(0);
    expect(
      await runCli(
        [
          "insert-text",
          projectPath,
          "document_main",
          "node_subtitle",
          "Subtitle",
          "--index",
          "1"
        ],
        capture.io
      )
    ).toBe(0);
    expect(await runCli(["inspect", projectPath, "--json"], capture.io)).toBe(
      0
    );
    expect(
      await runCli(
        ["branch", "create", projectPath, "proposal/alternate"],
        capture.io
      )
    ).toBe(0);
    expect(await runCli(["undo", projectPath], capture.io)).toBe(0);
    const undoneDocument = JSON.parse(
      await readFile(
        path.join(projectPath, "documents", "main.composition.json"),
        "utf8"
      )
    ) as { data: { rootNodeIds: string[] } };
    expect(undoneDocument.data.rootNodeIds).toEqual(["node_headline"]);
    expect(await runCli(["redo", projectPath], capture.io)).toBe(0);
    expect(await runCli(["history", projectPath, "--json"], capture.io)).toBe(
      0
    );

    const document = JSON.parse(
      await readFile(
        path.join(projectPath, "documents", "main.composition.json"),
        "utf8"
      )
    ) as {
      data: {
        rootNodeIds: string[];
        nodes: Record<string, { properties: Record<string, unknown> }>;
      };
    };
    expect(document.data.rootNodeIds).toEqual([
      "node_headline",
      "node_subtitle"
    ]);
    expect(document.data.nodes.node_headline?.properties.content).toEqual({
      kind: "constant",
      value: "你好，织时"
    });
    const history = JSON.parse(
      await readFile(
        path.join(projectPath, ".kineweave", "history", "history.json"),
        "utf8"
      )
    ) as {
      branches: { main: string };
      commits: Record<string, { parentCommitIds: string[] }>;
    };
    expect(Object.keys(history.commits)).toHaveLength(2);
    expect(history.branches).toMatchObject({
      main: expect.any(String),
      "proposal/alternate": expect.any(String)
    });
    const head = history.commits[history.branches.main];
    expect(head).toBeDefined();
    expect(head!.parentCommitIds[0]).not.toBe("commit_root");
    expect(history.commits[head!.parentCommitIds[0]!]).toBeDefined();
    expect(capture.output().stderr).toBe("");
  });

  it("returns a usage error for invalid JSON values", async () => {
    const projectPath = await temporaryProjectPath();
    const capture = captureIo();
    await runCli(["init", projectPath], capture.io);
    expect(
      await runCli(
        [
          "set-property",
          projectPath,
          "document_main",
          "node_headline",
          "content",
          "not-json"
        ],
        capture.io
      )
    ).toBe(2);
    expect(capture.output().stderr).toMatch(/valid JSON/i);
  });

  it("commits edits to a selected branch without replacing the materialized main document", async () => {
    const projectPath = await temporaryProjectPath();
    const capture = captureIo();
    await runCli(["init", projectPath], capture.io);
    await runCli(
      ["branch", "create", projectPath, "proposal/alternate"],
      capture.io
    );

    expect(
      await runCli(
        [
          "set-property",
          projectPath,
          "document_main",
          "node_headline",
          "content",
          '"Branch Version"',
          "--branch",
          "proposal/alternate"
        ],
        capture.io
      )
    ).toBe(0);
    const materialized = JSON.parse(
      await readFile(
        path.join(projectPath, "documents", "main.composition.json"),
        "utf8"
      )
    ) as { data: { nodes: Record<string, { properties: Record<string, unknown> }> } };
    expect(materialized.data.nodes.node_headline?.properties.content).toEqual({
      kind: "constant",
      value: "Hello KineWeave"
    });

    const branchCapture = captureIo();
    expect(
      await runCli(
        [
          "evaluate",
          projectPath,
          "document_main",
          "0",
          "--branch",
          "proposal/alternate",
          "--json"
        ],
        branchCapture.io
      )
    ).toBe(0);
    const graph = JSON.parse(branchCapture.output().stdout) as {
      nodes: Record<string, { data: { text: string } }>;
    };
    expect(graph.nodes.node_headline?.data.text).toBe("Branch Version");

    const history = JSON.parse(
      await readFile(
        path.join(projectPath, ".kineweave", "history", "history.json"),
        "utf8"
      )
    ) as { branches: Record<string, string> };
    expect(history.branches["proposal/alternate"]).not.toBe(history.branches.main);
    expect(capture.output().stderr).toBe("");
  });

  it("evaluates a project into a presentation graph", async () => {
    const projectPath = await temporaryProjectPath();
    await runCli(["init", projectPath], captureIo().io);
    const capture = captureIo();

    expect(
      await runCli(
        ["evaluate", projectPath, "document_main", "1/2", "--json"],
        capture.io
      )
    ).toBe(0);
    const graph = JSON.parse(capture.output().stdout) as {
      presentationGraphVersion: number;
      nodes: Record<string, { primitive: string; data: Record<string, unknown> }>;
    };
    expect(graph.presentationGraphVersion).toBe(1);
    expect(graph.nodes.node_headline).toMatchObject({
      primitive: "org.kineweave.presentation/text",
      data: { text: "Hello KineWeave" }
    });
    expect(capture.output().stderr).toBe("");
  });

  it("renders a deterministic SVG through the locked renderer capability", async () => {
    const projectPath = await temporaryProjectPath();
    await runCli(["init", projectPath], captureIo().io);
    const outputPath = path.join(projectPath, "outputs", "frame.svg");
    const capture = captureIo();

    expect(
      await runCli(
        [
          "render",
          projectPath,
          "document_main",
          "1/2",
          outputPath,
          "--json"
        ],
        capture.io
      )
    ).toBe(0);
    const svg = await readFile(outputPath, "utf8");
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain("Hello KineWeave");
    expect(JSON.parse(capture.output().stdout)).toMatchObject({
      mediaType: "image/svg+xml",
      rendererProviderId: "org.kineweave.renderer/svg"
    });
    expect(capture.output().stderr).toBe("");
  });

  it("rejects a project whose locked required extension is unavailable", async () => {
    const projectPath = await temporaryProjectPath();
    const capture = captureIo();
    await runCli(["init", projectPath], capture.io);

    const manifestPath = path.join(projectPath, "kineweave.project.json");
    const lockfilePath = path.join(projectPath, "kineweave.lock.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      extensionRequirements: Record<string, unknown>;
    };
    const lockfile = JSON.parse(await readFile(lockfilePath, "utf8")) as {
      extensions: Record<string, unknown>;
    };
    manifest.extensionRequirements["org.example.missing"] = {
      versionRange: "1.0.0",
      source: { kind: "package", packageName: "@example/missing" }
    };
    lockfile.extensions["org.example.missing"] = {
      version: "1.0.0",
      source: { kind: "package", packageName: "@example/missing" }
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`);

    expect(await runCli(["validate", projectPath], capture.io)).toBe(1);
    expect(capture.output().stdout).toMatch(/extension\.lockfile\.unavailable/);
  });
});
