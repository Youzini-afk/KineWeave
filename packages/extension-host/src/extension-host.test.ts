import { describe, expect, it } from "vitest";
import type { ExtensionManifest } from "@kineweave/protocol";
import { ExtensionHost } from "./extension-host.js";

function manifest(
  extensionId: string,
  dependencies: ExtensionManifest["dependencies"] = {}
): ExtensionManifest {
  return {
    manifestVersion: 1,
    extensionId,
    version: "1.0.0",
    kineweaveVersion: "^0.1.0",
    apiStability: "experimental",
    dependencies,
    entrypoints: [],
    contributes: {}
  };
}

describe("ExtensionHost", () => {
  it("discovers and resolves manifests without executing extension code", () => {
    let loadCount = 0;
    const host = new ExtensionHost({
      kineweaveVersion: "0.1.0",
      hostKind: "desktop",
      supportedRuntimes: ["worker"],
      createActivationContext: () => ({})
    });
    host.discover({
      manifest: manifest("org.example.extension"),
      load() {
        loadCount += 1;
        return { activate() {} };
      }
    });
    const plan = host.resolve({
      requirements: {
        "org.example.extension": { versionRange: "^1.0.0" }
      }
    });

    expect(plan.diagnostics).toEqual([]);
    expect(loadCount).toBe(0);
    expect(host.statuses()[0]?.state).toBe("resolved");
  });

  it("selects only entrypoints compatible with the host and runtime", async () => {
    let loadedModule = "";
    const host = new ExtensionHost({
      kineweaveVersion: "0.1.0",
      hostKind: "desktop",
      supportedRuntimes: ["worker"],
      createActivationContext: () => ({})
    });
    const value: ExtensionManifest = {
      ...manifest("org.example.entrypoint"),
      entrypoints: [
        {
          runtime: "workbench",
          module: "./web.js",
          hostKinds: ["web"]
        },
        {
          runtime: "worker",
          module: "./desktop-worker.js",
          hostKinds: ["desktop"]
        }
      ]
    };
    host.discover({
      manifest: value,
      load(entrypoint) {
        loadedModule = entrypoint?.module ?? "";
        return { activate() {} };
      }
    });
    const plan = host.resolve({
      requirements: {
        "org.example.entrypoint": { versionRange: "^1.0.0" }
      }
    });

    expect(plan.diagnostics).toEqual([]);
    await host.activate(plan);
    expect(loadedModule).toBe("./desktop-worker.js");
  });

  it("rejects an extension with no compatible entrypoint", () => {
    const host = new ExtensionHost({
      kineweaveVersion: "0.1.0",
      hostKind: "desktop",
      supportedRuntimes: ["worker"],
      createActivationContext: () => ({})
    });
    host.discover({
      manifest: {
        ...manifest("org.example.web-only"),
        entrypoints: [
          {
            runtime: "workbench",
            module: "./web.js",
            hostKinds: ["web"]
          }
        ]
      },
      load: () => ({ activate() {} })
    });

    const plan = host.resolve({
      requirements: {
        "org.example.web-only": { versionRange: "^1.0.0" }
      }
    });
    expect(plan.diagnostics).toEqual([
      expect.objectContaining({ code: "extension.entrypoint.unavailable" })
    ]);
  });

  it("ignores an incompatible optional dependency", () => {
    const host = new ExtensionHost({
      kineweaveVersion: "0.1.0",
      hostKind: "desktop",
      supportedRuntimes: ["worker"],
      createActivationContext: () => ({})
    });
    host.discover({
      manifest: {
        ...manifest("org.example.optional"),
        kineweaveVersion: "^9.0.0"
      },
      load: () => ({ activate() {} })
    });
    host.discover({
      manifest: manifest("org.example.parent", {
        "org.example.optional": { versionRange: "^1.0.0", optional: true }
      }),
      load: () => ({ activate() {} })
    });

    const plan = host.resolve({
      requirements: {
        "org.example.parent": { versionRange: "^1.0.0" }
      }
    });
    expect(plan.diagnostics).toEqual([]);
    expect(plan.extensions.map((item) => item.manifest.extensionId)).toEqual([
      "org.example.parent"
    ]);
  });

  it("backtracks extension versions across the complete requirement set", () => {
    const host = new ExtensionHost({
      kineweaveVersion: "0.1.0",
      hostKind: "desktop",
      supportedRuntimes: ["worker"],
      createActivationContext: () => ({})
    });
    const manifests: ExtensionManifest[] = [
      {
        ...manifest("org.example.feature", {
          "org.example.platform": { versionRange: "^2.0.0" }
        }),
        version: "1.1.0"
      },
      manifest("org.example.feature", {
        "org.example.platform": { versionRange: "^1.0.0" }
      }),
      { ...manifest("org.example.platform"), version: "2.0.0" },
      manifest("org.example.platform")
    ];
    for (const value of manifests) {
      host.discover({
        manifest: value,
        load: () => ({ activate() {} })
      });
    }

    const plan = host.resolve({
      requirements: {
        "org.example.feature": { versionRange: "^1.0.0" },
        "org.example.platform": { versionRange: "^1.0.0" }
      }
    });

    expect(plan.diagnostics).toEqual([]);
    expect(
      plan.extensions.map((item) => `${item.manifest.extensionId}@${item.manifest.version}`)
    ).toEqual([
      "org.example.platform@1.0.0",
      "org.example.feature@1.0.0"
    ]);
  });

  it("activates dependencies first and deactivates in reverse order", async () => {
    const events: string[] = [];
    const host = new ExtensionHost({
      kineweaveVersion: "0.1.0",
      hostKind: "desktop",
      supportedRuntimes: ["worker"],
      createActivationContext: (value) => ({ extensionId: value.extensionId })
    });
    for (const value of [
      manifest("org.example.base"),
      manifest("org.example.feature", {
        "org.example.base": { versionRange: "^1.0.0" }
      })
    ]) {
      host.discover({
        manifest: value,
        load() {
          return {
            activate(context) {
              events.push(`activate:${context.extensionId}`);
              return {
                deactivate() {
                  events.push(`deactivate:${context.extensionId}`);
                }
              };
            }
          };
        }
      });
    }
    const plan = host.resolve({
      requirements: {
        "org.example.feature": { versionRange: "^1.0.0" }
      }
    });
    await host.activate(plan);
    await host.deactivateAll();

    expect(events).toEqual([
      "activate:org.example.base",
      "activate:org.example.feature",
      "deactivate:org.example.feature",
      "deactivate:org.example.base"
    ]);
  });

  it("rolls back extensions activated earlier in a failed activation run", async () => {
    const events: string[] = [];
    const host = new ExtensionHost({
      kineweaveVersion: "0.1.0",
      hostKind: "desktop",
      supportedRuntimes: ["worker"],
      createActivationContext: (value) => value.extensionId
    });
    host.discover({
      manifest: manifest("org.example.base"),
      load: () => ({
        activate(context) {
          events.push(`activate:${context}`);
          return {
            deactivate: () => {
              events.push(`deactivate:${context}`);
            }
          };
        }
      })
    });
    host.discover({
      manifest: manifest("org.example.fail", {
        "org.example.base": { versionRange: "^1.0.0" }
      }),
      load: () => ({
        activate() {
          throw new Error("activation failed");
        }
      })
    });
    const plan = host.resolve({
      requirements: {
        "org.example.fail": { versionRange: "^1.0.0" }
      }
    });

    await expect(host.activate(plan)).rejects.toThrow(/activation failed/i);
    expect(events).toEqual([
      "activate:org.example.base",
      "deactivate:org.example.base"
    ]);
    expect(host.statuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          extensionId: "org.example.fail",
          state: "failed"
        })
      ])
    );
  });

  it("serializes concurrent activation requests without duplicate activation", async () => {
    let activationCount = 0;
    let releaseActivation!: () => void;
    const activationGate = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    const host = new ExtensionHost({
      kineweaveVersion: "0.1.0",
      hostKind: "desktop",
      supportedRuntimes: ["worker"],
      createActivationContext: () => ({})
    });
    host.discover({
      manifest: manifest("org.example.concurrent"),
      load: () => ({
        async activate() {
          activationCount += 1;
          await activationGate;
        }
      })
    });
    const plan = host.resolve({
      requirements: {
        "org.example.concurrent": { versionRange: "^1.0.0" }
      }
    });

    const first = host.activate(plan);
    const second = host.activate(plan);
    releaseActivation();
    await Promise.all([first, second]);

    expect(activationCount).toBe(1);
    expect(host.statuses()[0]?.state).toBe("activated");
  });

  it("continues reverse-order cleanup after one extension fails to deactivate", async () => {
    const events: string[] = [];
    const host = new ExtensionHost({
      kineweaveVersion: "0.1.0",
      hostKind: "desktop",
      supportedRuntimes: ["worker"],
      createActivationContext: (value) => value.extensionId
    });
    host.discover({
      manifest: manifest("org.example.base"),
      load: () => ({
        activate(context) {
          return {
            deactivate() {
              events.push(`deactivate:${context}`);
            }
          };
        }
      })
    });
    host.discover({
      manifest: manifest("org.example.feature", {
        "org.example.base": { versionRange: "^1.0.0" }
      }),
      load: () => ({
        activate(context) {
          return {
            deactivate() {
              events.push(`deactivate:${context}`);
              throw new Error("cleanup failed");
            }
          };
        }
      })
    });
    const plan = host.resolve({
      requirements: {
        "org.example.feature": { versionRange: "^1.0.0" }
      }
    });
    await host.activate(plan);

    await expect(host.deactivateAll()).rejects.toBeInstanceOf(AggregateError);
    expect(events).toEqual([
      "deactivate:org.example.feature",
      "deactivate:org.example.base"
    ]);
    expect(host.statuses()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          extensionId: "org.example.feature",
          state: "failed"
        }),
        expect.objectContaining({
          extensionId: "org.example.base",
          state: "deactivated"
        })
      ])
    );
  });
});
