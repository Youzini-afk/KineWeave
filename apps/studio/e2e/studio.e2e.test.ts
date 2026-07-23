import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { createOfficialProjectTemplate } from "@kineweave/official-distribution";
import { NodeProjectRepository } from "@kineweave/project-repository-node";
import type { StandardCompositionDocument } from "@kineweave/standard-motion-document";
import { type ElectronApplication, _electron as electron, type Page } from "playwright-core";
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

async function setPlayhead(page: Page, seconds: number): Promise<void> {
  await page.locator("#playhead").evaluate((element, value) => {
    const input = element as HTMLInputElement;
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, seconds);
}

test("authors motion, aligns layers, and reopens the saved project", async () => {
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

    const positionRow = window.locator('.timeline-property-row[data-property="position"]');
    const positionToggle = positionRow.locator('.property-key-toggle[data-property="position"]');
    await positionToggle.click();
    await expect.poll(() => positionRow.locator(".timeline-keyframe").count()).toBe(1);
    expect(await positionRow.locator(".timeline-keyframe").getAttribute("data-seconds")).toBe("0");

    await setPlayhead(window, 2);
    await expect.poll(() => window.locator("#timecode").textContent()).toBe("00:02.000");
    await positionToggle.click();
    await expect.poll(() => positionRow.locator(".timeline-keyframe").count()).toBe(2);

    const positionX = window
      .locator('.inspector-field[data-property="position"] .vector-field input')
      .first();
    await positionX.fill("1100");
    await positionX.blur();
    await expect.poll(() => window.locator("#status").textContent()).toContain("Updated position");

    const authoredMarker = positionRow.locator('.timeline-keyframe[data-seconds="2"]');
    await authoredMarker.focus();
    await authoredMarker.press("Shift+ArrowRight");
    await expect
      .poll(() =>
        positionRow
          .locator(".timeline-keyframe")
          .evaluateAll((markers) =>
            markers.map((marker) => (marker as HTMLElement).dataset.seconds).toSorted()
          )
      )
      .toEqual(["0", "2.1"]);

    await positionRow.locator('.timeline-keyframe[data-seconds="0"]').click();
    await window.locator("#keyframe-easing").selectOption("ease-in-out");
    await expect
      .poll(() => window.locator("#status").textContent())
      .toContain("Changed keyframe easing");
    await positionRow.locator('.timeline-keyframe[data-seconds="2.1"]').click();
    await expect.poll(() => window.locator("#timecode").textContent()).toBe("00:02.100");

    await window.locator('[data-add-node="rectangle"]').click();
    await expect.poll(() => window.locator("[role=treeitem]").count()).toBe(7);
    const secondLayer = window.locator('[role="treeitem"][aria-selected="true"]');
    const secondNodeId = await secondLayer.getAttribute("data-node-id");
    expect(secondNodeId).toMatch(/^node_rectangle_/);
    await window.locator("#layer-name").fill("E2E Rectangle B");
    await window.locator("#layer-name").blur();
    await expect.poll(() => secondLayer.textContent()).toContain("E2E Rectangle B");
    const secondPositionX = window
      .locator('.inspector-field[data-property="position"] .vector-field input')
      .first();
    await secondPositionX.fill("1400");
    await secondPositionX.blur();
    await expect.poll(() => window.locator("#status").textContent()).toContain("Updated position");

    const firstLayer = window.locator(`[role="treeitem"][data-node-id="${insertedNodeId}"]`);
    await firstLayer.click({ modifiers: ["Control"] });
    await expect
      .poll(() => window.locator('[role="treeitem"][aria-selected="true"]').count())
      .toBe(2);
    const alignLeft = window.locator('[data-align="left"]');
    await expect.poll(() => alignLeft.isEnabled()).toBe(true);
    await alignLeft.click();
    await expect.poll(() => window.locator("#status").textContent()).toContain("Aligned selection");

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

    const persisted = await repository.read(projectRoot);
    expect(persisted.diagnostics).toEqual([]);
    expect(persisted.snapshot).toBeDefined();
    const document = persisted.snapshot?.bundle.documents.document_main as
      | StandardCompositionDocument
      | undefined;
    expect(document?.data.nodes[insertedNodeId ?? ""]?.name).toBe("Persisted on close");
    const positionBinding = document?.data.nodes[insertedNodeId ?? ""]?.properties.position;
    if (positionBinding?.kind !== "track") throw new Error("Position track was not persisted");
    const positionTrack = document?.data.tracks[positionBinding.trackId];
    expect(Object.keys(positionTrack?.keyframes ?? {})).toHaveLength(2);
    expect(
      Object.values(positionTrack?.keyframes ?? {}).some(
        (keyframe) => Array.isArray(keyframe.value) && keyframe.value[0] === 1100
      )
    ).toBe(true);
    expect(
      Object.values(positionTrack?.keyframes ?? {}).some(
        (keyframe) => keyframe.easing?.kind === "cubic-bezier"
      )
    ).toBe(true);
    const secondPosition = document?.data.nodes[secondNodeId ?? ""]?.properties.position;
    expect(secondPosition).toEqual({ kind: "constant", value: [1100, 540] });
    expect(persisted.snapshot?.bundle.history.branches.main).not.toBe("commit_root");
    expect(rendererErrors).toEqual([]);

    application = await electron.launch({
      executablePath: electronPath,
      args: [studioRoot, "--project", projectRoot],
      cwd: repositoryRoot,
      timeout: 30_000
    });
    applicationClosed = false;
    const reopenedWindow = await application.firstWindow();
    const reopenedErrors: string[] = [];
    reopenedWindow.on("pageerror", (error) => reopenedErrors.push(error.message));
    await expect.poll(() => attribute(application!, ".studio-shell", "data-phase")).toBe("ready");
    expect(await attribute(application, ".studio-shell", "data-dirty")).toBe("false");
    const persistedLayer = reopenedWindow.locator(
      `[role="treeitem"][data-node-id="${insertedNodeId}"]`
    );
    await persistedLayer.click();
    await expect
      .poll(() => reopenedWindow.locator("#layer-name").inputValue())
      .toBe("Persisted on close");
    const reopenedPositionRow = reopenedWindow.locator(
      '.timeline-property-row[data-property="position"]'
    );
    await expect.poll(() => reopenedPositionRow.locator(".timeline-keyframe").count()).toBe(2);
    await reopenedPositionRow.locator('.timeline-keyframe[data-seconds="0"]').click();
    await expect
      .poll(() => reopenedWindow.locator("#keyframe-easing").inputValue())
      .toBe("ease-in-out");
    expect(reopenedErrors).toEqual([]);
  } finally {
    if (application !== undefined && !applicationClosed) {
      await application.close().catch(() => {});
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
