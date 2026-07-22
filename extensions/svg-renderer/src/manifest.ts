import type { ExtensionManifest } from "@kineweave/protocol";
import { svgRendererDescriptor } from "./descriptor.js";

export const svgRendererExtensionManifest: ExtensionManifest = {
  manifestVersion: 1,
  extensionId: "org.kineweave.svg-renderer",
  version: "0.1.0",
  kineweaveVersion: "^0.1.0",
  apiStability: "experimental",
  dependencies: {},
  entrypoints: [
    {
      runtime: "in-process",
      module: "./dist/index.js",
      exportName: "activateSvgRendererExtension",
      hostKinds: ["desktop", "web", "cli", "render-node"]
    }
  ],
  contributes: {
    capabilities: [svgRendererDescriptor]
  }
};
