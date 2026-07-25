import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { expect, test } from "vitest";
import { createKineWeaveWebServer } from "../src/server.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

test("opens, edits, saves and reloads the cloud project in a browser", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "kineweave-web-e2e-"));
  const server = await createKineWeaveWebServer({
    projectRoot: path.join(temporaryRoot, "project"),
    outputRoot: path.join(temporaryRoot, "outputs"),
    clientRoot: path.join(repositoryRoot, "apps", "web", "dist-client"),
    displayLocation: "Web E2E cloud",
    accessToken: "e2e-access-token"
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  const browser = await chromium.launch({ channel: "chrome", headless: true });

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}`);

    await expect.poll(() => page.locator("#auth-gate").isVisible()).toBe(true);
    await page.locator("#auth-token").fill("wrong-token");
    await page.locator("#auth-submit").click();
    await expect.poll(() => page.locator("#auth-error").textContent()).toContain("wasn't accepted");
    await page.locator("#auth-token").fill("e2e-access-token");
    await page.locator("#auth-submit").click();

    await expect.poll(() => page.locator(".studio-shell").getAttribute("data-phase")).toBe("ready");
    expect(await page.locator("#project-name").textContent()).toBe("KineWeave Cloud Project");
    expect(await page.locator("#project-path").textContent()).toBe("Web E2E cloud");
    expect(await page.locator('[role="treeitem"]').count()).toBe(5);

    await page.setViewportSize({ width: 1000, height: 900 });
    const curveEditor = page.locator("#easing-curve-editor");
    await curveEditor.evaluate((element) => {
      (element as HTMLElement).hidden = false;
    });
    expect(
      await curveEditor.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)
    ).toBe(true);
    await curveEditor.evaluate((element) => {
      (element as HTMLElement).hidden = true;
    });
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.locator('[data-add-node="rectangle"]').click();
    await expect.poll(() => page.locator('[role="treeitem"]').count()).toBe(6);
    await page.locator("#save").click();
    await expect.poll(() => page.locator("#save-state").textContent()).toBe("Saved");

    await page.locator("#output").click();
    await expect.poll(() => page.locator("#output-dialog").getAttribute("open")).not.toBeNull();
    await page.locator("#output-end").fill("1/30");
    await page.locator("#output-width").fill("64");
    await page.locator("#output-height").fill("64");
    await page.locator("#output-quality").selectOption("compact");
    await page.locator("#start-output").click();
    await expect
      .poll(() => page.locator("#output-dialog").getAttribute("data-status"), {
        timeout: 30_000
      })
      .toBe("succeeded");
    expect(await page.locator("#output-status").textContent()).toBe("Output ready");
    expect(
      await page
        .locator("#output-progress")
        .evaluate((element) => (element as HTMLProgressElement).value)
    ).toBe(1);

    const downloadEvent = page.waitForEvent("download");
    await page.locator("#open-output").click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe("KineWeave-output.mp4");
    const downloadedPath = await download.path();
    if (downloadedPath === null) throw new Error("Output download did not produce a file");
    expect((await stat(downloadedPath)).size).toBeGreaterThan(0);

    await page.locator("#output-end").fill("2");
    await page.locator("#start-output").click();
    await expect.poll(() => page.locator("#cancel-output").isEnabled()).toBe(true);
    await page.locator("#cancel-output").click();
    await expect
      .poll(() => page.locator("#output-dialog").getAttribute("data-status"), {
        timeout: 30_000
      })
      .toBe("cancelled");
    expect(await page.locator("#output-status").textContent()).toBe("Output cancelled");
    await page.locator("#close-output").click();

    await page.reload();
    await expect.poll(() => page.locator(".studio-shell").getAttribute("data-phase")).toBe("ready");
    expect(await page.locator('[role="treeitem"]').count()).toBe(6);
    await page.locator("#sign-out").click();
    await expect.poll(() => page.locator("#auth-gate").isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    server.close();
    await once(server, "close");
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}, 90_000);
