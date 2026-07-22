import {
  STANDARD_COLOR_SPACES,
  STANDARD_PRESENTATION_PRIMITIVES
} from "@kineweave/protocol";
import {
  PRESENTATION_RENDERER_CAPABILITY_ID,
  PRESENTATION_RENDERER_CONTRACT_VERSION
} from "@kineweave/render-engine";

export const SVG_RENDERER_PROVIDER_ID = "org.kineweave.renderer/svg";

export const svgRendererDescriptor = {
  capabilityId: PRESENTATION_RENDERER_CAPABILITY_ID,
  providerId: SVG_RENDERER_PROVIDER_ID,
  extensionId: "org.kineweave.svg-renderer",
  contractVersion: PRESENTATION_RENDERER_CONTRACT_VERSION,
  implementationVersion: "0.1.0",
  features: [
    STANDARD_PRESENTATION_PRIMITIVES.group,
    STANDARD_PRESENTATION_PRIMITIVES.text,
    STANDARD_COLOR_SPACES.srgb
  ],
  lifetime: "project",
  priority: 100,
  environment: {
    hostKinds: ["desktop", "web", "cli", "render-node"],
    evaluationModes: ["interactive", "deterministic", "live"]
  }
} as const;
