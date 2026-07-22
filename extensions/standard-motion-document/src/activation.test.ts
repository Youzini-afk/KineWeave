import { describe, expect, it } from "vitest";
import type { KineWeaveExtensionContext } from "@kineweave/extension-api";
import { activateStandardMotionExtension } from "./activation.js";
import { standardMotionExtensionManifest } from "./manifest.js";

describe("activateStandardMotionExtension", () => {
  it("rolls back contributions registered before a later registration fails", () => {
    let activeHandlers = 0;
    const registerHandler = () => {
      activeHandlers += 1;
      return () => {
        activeHandlers -= 1;
      };
    };
    const context: KineWeaveExtensionContext = {
      manifest: standardMotionExtensionManifest,
      hostKind: "cli",
      transactions: {
        registerOperationHandler: registerHandler,
        registerDocumentValidator() {
          throw new Error("validator registration failed");
        },
        registerCrossDocumentValidator: registerHandler,
        registerPrecondition: registerHandler
      },
      evaluation: {
        registerDocumentEvaluator: registerHandler
      },
      rendering: {
        registerOutputRenderer: registerHandler,
        registerInteractiveRenderer: registerHandler
      }
    };

    expect(() => activateStandardMotionExtension(context)).toThrow(
      /validator registration failed/i
    );
    expect(activeHandlers).toBe(0);
  });
});
