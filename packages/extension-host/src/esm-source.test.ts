import type { ExtensionManifest } from "@kineweave/protocol";
import { describe, expect, it, vi } from "vitest";
import { createEsmExtensionSource } from "./esm-source.js";

const manifest: ExtensionManifest = {
  manifestVersion: 1,
  extensionId: "org.example.esm",
  version: "1.0.0",
  kineweaveVersion: "^0.1.0",
  apiStability: "experimental",
  dependencies: {},
  entrypoints: [
    {
      runtime: "in-process",
      module: "./dist/index.js",
      exportName: "activateExtension"
    }
  ],
  contributes: {}
};

describe("createEsmExtensionSource", () => {
  it("loads the selected named activation export lazily", async () => {
    const activate = vi.fn();
    const importEntrypoint = vi.fn(async () => ({ activateExtension: activate }));
    const source = createEsmExtensionSource({ manifest, importEntrypoint });

    expect(importEntrypoint).not.toHaveBeenCalled();
    const module = await source.load(manifest.entrypoints[0]);
    await module.activate({});

    expect(importEntrypoint).toHaveBeenCalledWith(manifest.entrypoints[0]);
    expect(activate).toHaveBeenCalledWith({});
  });

  it("accepts an exported ExtensionModule", async () => {
    const activate = vi.fn();
    const source = createEsmExtensionSource({
      manifest,
      importEntrypoint: async () => ({ activateExtension: { activate } })
    });

    const module = await source.load(manifest.entrypoints[0]);
    await module.activate("context");
    expect(activate).toHaveBeenCalledWith("context");
  });

  it("rejects a missing or invalid activation export", async () => {
    const source = createEsmExtensionSource({
      manifest,
      importEntrypoint: async () => ({ activateExtension: 42 })
    });

    await expect(source.load(manifest.entrypoints[0])).rejects.toThrow(
      /must export an activation function/i
    );
    await expect(source.load(undefined)).rejects.toThrow(/no selected ESM entrypoint/i);
  });
});
