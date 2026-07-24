import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
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
    clientRoot: path.join(repositoryRoot, "apps", "web", "dist-client"),
    displayLocation: "Web E2E cloud"
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

    await expect.poll(() => page.locator(".studio-shell").getAttribute("data-phase")).toBe("ready");
    expect(await page.locator("#project-name").textContent()).toBe("KineWeave Cloud Project");
    expect(await page.locator("#project-path").textContent()).toBe("Web E2E cloud");
    expect(await page.locator('[role="treeitem"]').count()).toBe(5);

    await page.locator('[data-add-node="rectangle"]').click();
    await expect.poll(() => page.locator('[role="treeitem"]').count()).toBe(6);
    await page.locator("#save").click();
    await expect.poll(() => page.locator("#save-state").textContent()).toBe("Saved");

    await page.reload();
    await expect.poll(() => page.locator(".studio-shell").getAttribute("data-phase")).toBe("ready");
    expect(await page.locator('[role="treeitem"]').count()).toBe(6);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    server.close();
    await once(server, "close");
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
