import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LoadedProjectBundle } from "@kineweave/project-format";
import { NodeProjectRepository } from "@kineweave/project-repository-node";
import type { OpenedStudioProject, StudioHostResult } from "@kineweave/studio/host-api";
import { afterEach, describe, expect, it } from "vitest";
import { createKineWeaveWebServer } from "./server.js";
import { CLOUD_PROJECT_LOCATOR } from "./shared.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("KineWeave Web server", () => {
  it("serves the Studio and persists authenticated cloud sessions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kineweave-web-"));
    temporaryDirectories.push(root);
    const projectRoot = path.join(root, "project");
    const clientRoot = path.join(root, "client");
    await mkdir(clientRoot);
    await writeFile(path.join(clientRoot, "index.html"), "<h1>KineWeave</h1>", "utf8");

    const server = await createKineWeaveWebServer({
      projectRoot,
      clientRoot,
      accessToken: "test-token",
      displayLocation: "Test cloud"
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      expect(await (await fetch(`${baseUrl}/healthz`)).json()).toEqual({ status: "ok" });
      expect(await (await fetch(baseUrl)).text()).toContain("KineWeave");

      const unauthorized = await fetch(`${baseUrl}/api/project/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectLocator: CLOUD_PROJECT_LOCATOR })
      });
      expect(unauthorized.status).toBe(401);

      const headers = {
        authorization: "Bearer test-token",
        "content-type": "application/json"
      };
      const openResponse = await fetch(`${baseUrl}/api/project/open`, {
        method: "POST",
        headers,
        body: JSON.stringify({ projectLocator: CLOUD_PROJECT_LOCATOR })
      });
      const opened = (await openResponse.json()) as StudioHostResult<OpenedStudioProject>;
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw new Error(opened.error.message);
      expect(opened.value.displayLocation).toBe("Test cloud");

      const bundle = structuredClone(opened.value.bundle) as LoadedProjectBundle;
      (bundle.manifest as { name: string }).name = "Saved through Web";
      const saveResponse = await fetch(
        `${baseUrl}/api/project/sessions/${opened.value.hostSessionId}`,
        {
          method: "PUT",
          headers,
          body: JSON.stringify({ bundle })
        }
      );
      expect(saveResponse.status).toBe(200);
      await fetch(`${baseUrl}/api/project/sessions/${opened.value.hostSessionId}`, {
        method: "DELETE",
        headers: { authorization: "Bearer test-token" }
      });

      const persisted = await new NodeProjectRepository().read(projectRoot);
      expect(persisted.snapshot?.bundle.manifest.name).toBe("Saved through Web");
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
