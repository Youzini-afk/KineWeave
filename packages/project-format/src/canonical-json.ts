import { assertJsonValue, type JsonObject, type JsonValue } from "@kineweave/protocol";

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalizeJson<T extends JsonValue>(value: T): T {
  assertJsonValue(value);

  function visit(current: JsonValue): JsonValue {
    if (Array.isArray(current)) {
      return current.map(visit);
    }
    if (current !== null && typeof current === "object") {
      const result: JsonObject = {};
      for (const key of Object.keys(current).sort(compareKeys)) {
        result[key] = visit(current[key]!);
      }
      return result;
    }
    return current;
  }

  return visit(value) as T;
}

export interface CanonicalStringifyOptions {
  readonly indent?: number;
  readonly trailingNewline?: boolean;
}

export function canonicalStringify(
  value: JsonValue,
  options: CanonicalStringifyOptions = {}
): string {
  const indent = options.indent ?? 2;
  if (!Number.isInteger(indent) || indent < 0 || indent > 10) {
    throw new RangeError("Canonical JSON indent must be an integer from 0 to 10");
  }
  const serialized = JSON.stringify(canonicalizeJson(value), null, indent);
  return options.trailingNewline === false ? serialized : `${serialized}\n`;
}
