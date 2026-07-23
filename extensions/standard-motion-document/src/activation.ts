import type { KineWeaveExtensionContext } from "@kineweave/extension-api";
import { standardMotionDocumentEvaluator } from "./evaluator.js";
import { STANDARD_COMPOSITION_SCHEMA_VERSION, STANDARD_COMPOSITION_TYPE } from "./model.js";
import { standardMotionOperationHandlers } from "./operations.js";
import { validateStandardComposition } from "./validation.js";

export interface StandardMotionExtensionActivation {
  readonly deactivate: () => void;
}

export function activateStandardMotionExtension(
  context: KineWeaveExtensionContext
): StandardMotionExtensionActivation {
  const disposers: (() => void)[] = [];
  const disposeRegisteredContributions = (): void => {
    const failures: unknown[] = [];
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch (caught) {
        failures.push(caught);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to dispose all Standard Motion contributions");
    }
  };

  try {
    for (const handler of standardMotionOperationHandlers) {
      disposers.push(context.transactions.registerOperationHandler(handler));
    }
    disposers.push(
      context.transactions.registerDocumentValidator({
        documentType: STANDARD_COMPOSITION_TYPE,
        schemaVersion: STANDARD_COMPOSITION_SCHEMA_VERSION,
        validate(document) {
          return validateStandardComposition(document);
        }
      })
    );
    disposers.push(context.evaluation.registerDocumentEvaluator(standardMotionDocumentEvaluator));
  } catch (caught) {
    try {
      disposeRegisteredContributions();
    } catch (cleanupError) {
      throw new AggregateError(
        [caught, cleanupError],
        "Standard Motion activation failed and rollback was incomplete",
        { cause: caught }
      );
    }
    throw caught;
  }
  return {
    deactivate() {
      disposeRegisteredContributions();
    }
  };
}
