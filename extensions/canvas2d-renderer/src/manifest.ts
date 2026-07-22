import type { ExtensionManifest } from "@kineweave/protocol";
import { canvas2dRendererDescriptor } from "./descriptor.js";

export const canvas2dRendererExtensionManifest: ExtensionManifest = {
  manifestVersion: 1,
  extensionId: "org.kineweave.canvas2d-renderer",
  version: "0.1.0",
  kineweaveVersion: "^0.1.0",
  apiStability: "experimental",
  dependencies: {},
  entrypoints: [
    {
      runtime: "in-process",
      module: "./dist/index.js",
      exportName: "activateCanvas2dRendererExtension",
      hostKinds: ["desktop", "web", "cli", "render-node"]
    }
  ],
  contributes: {
    capabilities: [canvas2dRendererDescriptor]
  }
};
