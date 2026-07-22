import {
  STANDARD_COLOR_SPACES,
  STANDARD_PRESENTATION_PRIMITIVES
} from "@kineweave/protocol";
import {
  INTERACTIVE_RENDERER_CAPABILITY_ID,
  INTERACTIVE_RENDERER_CONTRACT_VERSION
} from "@kineweave/render-engine";

export const CANVAS2D_RENDERER_PROVIDER_ID =
  "org.kineweave.renderer/canvas2d";
export const CANVAS2D_SURFACE_TYPE = "org.kineweave.surface/canvas2d";

export const canvas2dRendererDescriptor = {
  capabilityId: INTERACTIVE_RENDERER_CAPABILITY_ID,
  providerId: CANVAS2D_RENDERER_PROVIDER_ID,
  extensionId: "org.kineweave.canvas2d-renderer",
  contractVersion: INTERACTIVE_RENDERER_CONTRACT_VERSION,
  implementationVersion: "0.1.0",
  features: [
    CANVAS2D_SURFACE_TYPE,
    STANDARD_PRESENTATION_PRIMITIVES.group,
    STANDARD_PRESENTATION_PRIMITIVES.text,
    STANDARD_PRESENTATION_PRIMITIVES.rectangle,
    STANDARD_PRESENTATION_PRIMITIVES.ellipse,
    STANDARD_PRESENTATION_PRIMITIVES.path,
    STANDARD_COLOR_SPACES.srgb
  ],
  lifetime: "project",
  priority: 100,
  environment: {
    hostKinds: ["desktop", "web"],
    evaluationModes: ["interactive", "deterministic", "live"]
  }
} as const;
