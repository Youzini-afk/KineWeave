import type { KineWeaveExtensionContext } from "@kineweave/extension-api";
import { svgRendererProvider } from "./renderer.js";

export function activateSvgRendererExtension(context: KineWeaveExtensionContext) {
  const dispose = context.rendering.registerOutputRenderer(svgRendererProvider);
  return { deactivate: dispose };
}
