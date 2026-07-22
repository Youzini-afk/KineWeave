import type { KineWeaveExtensionContext } from "@kineweave/extension-api";
import {
  createEsmExtensionSource,
  type EsmModuleNamespace
} from "@kineweave/extension-host";
import type { KineWeaveDistributionProfile } from "@kineweave/project-session";
import { PRESENTATION_RENDERER_CAPABILITY_ID } from "@kineweave/render-engine";
import { standardMotionExtensionManifest } from "@kineweave/standard-motion-document/manifest";
import { SVG_RENDERER_PROVIDER_ID } from "@kineweave/svg-renderer/descriptor";
import { svgRendererExtensionManifest } from "@kineweave/svg-renderer/manifest";

export const KINEWEAVE_VERSION = "0.1.0";
export const OFFICIAL_DISTRIBUTION_PROFILE_ID =
  "org.kineweave.distribution/standard";

function assertEntrypointModule(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new TypeError(`Unexpected official extension entrypoint ${actual}`);
  }
}

export function createOfficialDistributionProfile(): KineWeaveDistributionProfile {
  return {
    descriptor: {
      profileId: OFFICIAL_DISTRIBUTION_PROFILE_ID,
      version: KINEWEAVE_VERSION,
      capabilityDefaults: {
        [PRESENTATION_RENDERER_CAPABILITY_ID]: SVG_RENDERER_PROVIDER_ID
      }
    },
    extensions: [
      createEsmExtensionSource<KineWeaveExtensionContext>({
        manifest: standardMotionExtensionManifest,
        async importEntrypoint(entrypoint): Promise<EsmModuleNamespace> {
          assertEntrypointModule(entrypoint.module, "./dist/index.js");
          return import("@kineweave/standard-motion-document") as Promise<EsmModuleNamespace>;
        }
      }),
      createEsmExtensionSource<KineWeaveExtensionContext>({
        manifest: svgRendererExtensionManifest,
        async importEntrypoint(entrypoint): Promise<EsmModuleNamespace> {
          assertEntrypointModule(entrypoint.module, "./dist/index.js");
          return import("@kineweave/svg-renderer") as Promise<EsmModuleNamespace>;
        }
      })
    ]
  };
}
