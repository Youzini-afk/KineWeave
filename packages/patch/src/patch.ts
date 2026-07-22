import { hashJson } from "@kineweave/content-hash";
import {
  cloneJson,
  type DocumentPatch,
  type JsonPatchOperation,
  type JsonValue
} from "@kineweave/protocol";
import {
  addAtPointer,
  escapeJsonPointerSegment,
  removeAtPointer,
  replaceAtPointer
} from "./json-pointer.js";

function equalJson(left: JsonValue, right: JsonValue): boolean {
  return hashJson(left) === hashJson(right);
}

export function diffJson(
  before: JsonValue,
  after: JsonValue,
  path = ""
): readonly JsonPatchOperation[] {
  if (equalJson(before, after)) return [];

  if (Array.isArray(before) || Array.isArray(after)) {
    return [{ op: "replace", path, value: cloneJson(after) }];
  }

  const beforeObject =
    before !== null && typeof before === "object" ? before : undefined;
  const afterObject =
    after !== null && typeof after === "object" ? after : undefined;

  if (beforeObject === undefined || afterObject === undefined) {
    return [{ op: "replace", path, value: cloneJson(after) }];
  }

  const operations: JsonPatchOperation[] = [];
  const beforeKeys = new Set(Object.keys(beforeObject));
  const afterKeys = new Set(Object.keys(afterObject));

  for (const key of [...beforeKeys].filter((item) => !afterKeys.has(item)).sort()) {
    operations.push({
      op: "remove",
      path: `${path}/${escapeJsonPointerSegment(key)}`
    });
  }
  for (const key of [...afterKeys].filter((item) => !beforeKeys.has(item)).sort()) {
    operations.push({
      op: "add",
      path: `${path}/${escapeJsonPointerSegment(key)}`,
      value: cloneJson(afterObject[key]!)
    });
  }
  for (const key of [...beforeKeys].filter((item) => afterKeys.has(item)).sort()) {
    operations.push(
      ...diffJson(
        beforeObject[key]!,
        afterObject[key]!,
        `${path}/${escapeJsonPointerSegment(key)}`
      )
    );
  }

  return operations;
}

export function applyJsonPatch(
  value: JsonValue,
  operations: readonly JsonPatchOperation[]
): JsonValue {
  let result = cloneJson(value);
  for (const operation of operations) {
    switch (operation.op) {
      case "add":
        result = addAtPointer(result, operation.path, operation.value);
        break;
      case "remove":
        result = removeAtPointer(result, operation.path);
        break;
      case "replace":
        result = replaceAtPointer(result, operation.path, operation.value);
        break;
    }
  }
  return result;
}

export function createDocumentPatch(
  documentId: string,
  before: JsonValue | null,
  after: JsonValue | null
): DocumentPatch {
  if (before === null && after === null) {
    throw new TypeError("A document patch must create, change or delete a document");
  }

  if (before === null) {
    return {
      documentId,
      beforeHash: null,
      afterHash: hashJson(after!),
      forward: [{ op: "add", path: "", value: cloneJson(after!) }],
      inverse: [{ op: "remove", path: "" }]
    };
  }

  if (after === null) {
    return {
      documentId,
      beforeHash: hashJson(before),
      afterHash: null,
      forward: [{ op: "remove", path: "" }],
      inverse: [{ op: "add", path: "", value: cloneJson(before) }]
    };
  }

  return {
    documentId,
    beforeHash: hashJson(before),
    afterHash: hashJson(after),
    forward: diffJson(before, after),
    inverse: diffJson(after, before)
  };
}

export function applyDocumentPatch(
  current: JsonValue | null,
  patch: DocumentPatch,
  direction: "forward" | "inverse" = "forward"
): JsonValue | null {
  const expectedHash = direction === "forward" ? patch.beforeHash : patch.afterHash;
  const resultHash = direction === "forward" ? patch.afterHash : patch.beforeHash;
  const operations = direction === "forward" ? patch.forward : patch.inverse;
  const actualHash = current === null ? null : hashJson(current);

  if (actualHash !== expectedHash) {
    throw new Error(
      `Patch base mismatch for ${patch.documentId}: expected ${expectedHash ?? "missing"}, got ${actualHash ?? "missing"}`
    );
  }

  let result = current;
  for (const operation of operations) {
    if (operation.path === "" && operation.op === "remove") {
      result = null;
      continue;
    }
    if (operation.path === "" && operation.op === "add") {
      result = cloneJson(operation.value);
      continue;
    }
    if (result === null) {
      throw new Error(`Cannot apply ${operation.op} to a missing document`);
    }
    result = applyJsonPatch(result, [operation]);
  }

  const actualResultHash = result === null ? null : hashJson(result);
  if (actualResultHash !== resultHash) {
    throw new Error(
      `Patch result mismatch for ${patch.documentId}: expected ${resultHash ?? "missing"}, got ${actualResultHash ?? "missing"}`
    );
  }
  return result;
}
