import type { KineWeaveExtensionContext } from "@kineweave/extension-api";
import { canvas2dRendererProvider } from "./renderer.js";

export function activateCanvas2dRendererExtension(
  context: KineWeaveExtensionContext
) {
  const dispose = context.rendering.registerInteractiveRenderer(
    canvas2dRendererProvider
  );
  return { deactivate: dispose };
}
