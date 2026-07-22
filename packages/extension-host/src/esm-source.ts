import type { ExtensionEntrypoint, ExtensionManifest } from "@kineweave/protocol";
import type { DiscoveredExtension, ExtensionModule } from "./types.js";

export type EsmModuleNamespace = Readonly<Record<string, unknown>>;

export interface EsmExtensionSourceOptions<TContext> {
  readonly manifest: ExtensionManifest;
  readonly importEntrypoint: (
    entrypoint: ExtensionEntrypoint
  ) => Promise<EsmModuleNamespace>;
}

function isExtensionModule<TContext>(value: unknown): value is ExtensionModule<TContext> {
  return (
    typeof value === "object" &&
    value !== null &&
    "activate" in value &&
    typeof value.activate === "function"
  );
}

export function createEsmExtensionSource<TContext>(
  options: EsmExtensionSourceOptions<TContext>
): DiscoveredExtension<TContext> {
  return {
    manifest: options.manifest,
    async load(entrypoint) {
      if (entrypoint === undefined) {
        throw new TypeError(
          `Extension ${options.manifest.extensionId} has no selected ESM entrypoint`
        );
      }
      const namespace = await options.importEntrypoint(entrypoint);
      const exportName = entrypoint.exportName ?? "default";
      const exported = namespace[exportName];
      if (typeof exported === "function") {
        return { activate: exported as ExtensionModule<TContext>["activate"] };
      }
      if (isExtensionModule<TContext>(exported)) return exported;
      throw new TypeError(
        `Extension ${options.manifest.extensionId} entrypoint ${entrypoint.module} must export an activation function or ExtensionModule as ${exportName}`
      );
    }
  };
}
