import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOfficialProjectTemplate } from "@kineweave/official-distribution";
import { NodeProjectRepository } from "@kineweave/project-repository-node";
import type { StandardCompositionDocument } from "@kineweave/standard-motion-document";
import { type ElectronApplication, _electron as electron } from "playwright-core";
import { expect, test } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const studioRoot = path.join(repositoryRoot, "apps", "studio");
const requireFromStudio = createRequire(path.join(studioRoot, "package.json"));
const electronPath = requireFromStudio("electron") as string;

async function attribute(
  application: ElectronApplication,
  selector: string,
  name: string
): Promise<string | null> {
  return application.windows()[0]?.locator(selector).getAttribute(name) ?? null;
}

test("edits one project session and persists queued changes before native close", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "kineweave-studio-e2e-"));
  const projectRoot = path.join(temporaryRoot, "project");
  const repository = new NodeProjectRepository();
  await repository.initialize(
    projectRoot,
    createOfficialProjectTemplate({
      name: "Studio E2E",
      projectId: "project_studio_e2e"
    })
  );

  let application: ElectronApplication | undefined;
  let applicationClosed = false;
  try {
    application = await electron.launch({
      executablePath: electronPath,
      args: [studioRoot, "--project", projectRoot],
      cwd: repositoryRoot,
      timeout: 30_000
    });
    const window = await application.firstWindow();
    const rendererErrors: string[] = [];
    window.on("pageerror", (error) => rendererErrors.push(error.message));

    await expect.poll(() => attribute(application!, ".studio-shell", "data-phase")).toBe("ready");
    expect(await window.locator("#project-name").textContent()).toBe("Studio E2E");
    expect(await window.locator("#welcome").getAttribute("aria-hidden")).toBe("true");
    expect(await window.locator("#save-state").textContent()).toBe("Saved");
    expect(await window.locator("[role=treeitem]").count()).toBe(5);

    await window.locator('[data-add-node="rectangle"]').click();
    await expect.poll(() => window.locator("[role=treeitem]").count()).toBe(6);
    const selectedLayer = window.locator('[role="treeitem"][aria-selected="true"]');
    await expect
      .poll(() => selectedLayer.getAttribute("data-node-type"))
      .toBe("org.kineweave.standard-motion/rectangle");
    const insertedNodeId = await selectedLayer.getAttribute("data-node-id");
    expect(insertedNodeId).toMatch(/^node_rectangle_/);
    expect(await window.locator("#selection-polygon").getAttribute("points")).not.toBe("");

    const nameInput = window.locator("#layer-name");
    const originalName = await nameInput.inputValue();
    await nameInput.fill("E2E Rectangle");
    await nameInput.blur();
    await expect.poll(() => selectedLayer.textContent()).toContain("E2E Rectangle");
    await expect.poll(() => attribute(application!, ".studio-shell", "data-dirty")).toBe("true");
    expect(await window.locator(".history-row").count()).toBe(2);

    await window.locator("#undo").click();
    await expect.poll(() => window.locator("#layer-name").inputValue()).toBe(originalName);
    await window.locator("#redo").click();
    await expect.poll(() => window.locator("#layer-name").inputValue()).toBe("E2E Rectangle");

    const initialTimecode = await window.locator("#timecode").textContent();
    await window.locator("#play").click();
    await expect.poll(() => window.locator("#timecode").textContent()).not.toBe(initialTimecode);
    await window.locator("#play").click();
    await expect.poll(() => attribute(application!, ".studio-shell", "data-playing")).toBe("false");

    await window.locator("#save").click();
    await expect.poll(() => attribute(application!, ".studio-shell", "data-dirty")).toBe("false");
    expect(await window.locator("#save-state").textContent()).toBe("Saved");

    await window.locator("#layer-name").fill("Persisted on close");
    await window.locator("#layer-name").blur();
    await expect.poll(() => attribute(application!, ".studio-shell", "data-dirty")).toBe("true");

    const closed = new Promise<void>((resolve) => application!.once("close", resolve));
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await closed;
    applicationClosed = true;

    const reopened = await repository.read(projectRoot);
    expect(reopened.diagnostics).toEqual([]);
    expect(reopened.snapshot).toBeDefined();
    const document = reopened.snapshot?.bundle.documents.document_main as
      | StandardCompositionDocument
      | undefined;
    expect(document?.data.nodes[insertedNodeId ?? ""]?.name).toBe("Persisted on close");
    expect(reopened.snapshot?.bundle.history.branches.main).not.toBe("commit_root");
    expect(rendererErrors).toEqual([]);
  } finally {
    if (application !== undefined && !applicationClosed) {
      await application.close().catch(() => {});
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
