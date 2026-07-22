import {
  hasErrorDiagnostics,
  type Diagnostic,
  type JsonObject,
  type KineWeaveHistory,
  type KineWeaveLockfile,
  type KineWeaveProjectManifest,
  type ProjectDocumentEnvelope
} from "@kineweave/protocol";
import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction
} from "ajv/dist/2020.js";
import documentEnvelopeSchema from "./schemas/document-envelope-v1.schema.json" with { type: "json" };
import historySchema from "./schemas/history-v1.schema.json" with { type: "json" };
import lockfileSchema from "./schemas/lockfile-v1.schema.json" with { type: "json" };
import projectSchema from "./schemas/project-v1.schema.json" with { type: "json" };

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  removeAdditional: false,
  useDefaults: false,
  coerceTypes: false
});

const projectValidator = ajv.compile(projectSchema);
const lockfileValidator = ajv.compile(lockfileSchema);
const documentEnvelopeValidator = ajv.compile(documentEnvelopeSchema);
const historyValidator = ajv.compile(historySchema);

function diagnosticsFromErrors(
  source: string,
  errors: readonly ErrorObject[] | null | undefined
): readonly Diagnostic[] {
  return (errors ?? []).map((error) => ({
    severity: "error",
    code: `${source}.schema.${error.keyword}`,
    message: error.message ?? `Schema keyword ${error.keyword} failed`,
    jsonPointer: error.instancePath || "/",
    source: "@kineweave/project-format"
  }));
}

function validateWith(
  source: string,
  validator: ValidateFunction,
  value: unknown
): readonly Diagnostic[] {
  validator(value);
  return diagnosticsFromErrors(source, validator.errors);
}

export function validateProjectManifestSchema(
  value: unknown
): readonly Diagnostic[] {
  return validateWith("project", projectValidator, value);
}

export function validateLockfileSchema(value: unknown): readonly Diagnostic[] {
  return validateWith("lockfile", lockfileValidator, value);
}

export function validateDocumentEnvelopeSchema(
  value: unknown
): readonly Diagnostic[] {
  return validateWith("document", documentEnvelopeValidator, value);
}

export function validateHistorySchema(value: unknown): readonly Diagnostic[] {
  return validateWith("history", historyValidator, value);
}

export function assertProjectManifest(
  value: unknown
): asserts value is KineWeaveProjectManifest {
  const diagnostics = validateProjectManifestSchema(value);
  if (hasErrorDiagnostics(diagnostics)) {
    throw new TypeError(diagnostics.map((item) => item.message).join("; "));
  }
}

export function assertLockfile(
  value: unknown
): asserts value is KineWeaveLockfile {
  const diagnostics = validateLockfileSchema(value);
  if (hasErrorDiagnostics(diagnostics)) {
    throw new TypeError(diagnostics.map((item) => item.message).join("; "));
  }
}

export function assertDocumentEnvelope(
  value: unknown
): asserts value is ProjectDocumentEnvelope<JsonObject> {
  const diagnostics = validateDocumentEnvelopeSchema(value);
  if (hasErrorDiagnostics(diagnostics)) {
    throw new TypeError(diagnostics.map((item) => item.message).join("; "));
  }
}

export function assertHistory(value: unknown): asserts value is KineWeaveHistory {
  const diagnostics = validateHistorySchema(value);
  if (hasErrorDiagnostics(diagnostics)) {
    throw new TypeError(diagnostics.map((item) => item.message).join("; "));
  }
}
