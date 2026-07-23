export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export function isJsonValue(value: unknown): value is JsonValue {
  return inspectJsonValue(value).valid;
}

export interface JsonInspection {
  readonly valid: boolean;
  readonly path?: string;
  readonly reason?: string;
}

export function inspectJsonValue(value: unknown): JsonInspection {
  const ancestors = new WeakSet<object>();

  function inspect(current: unknown, path: string): JsonInspection {
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return { valid: true };
    }

    if (typeof current === "number") {
      return Number.isFinite(current)
        ? { valid: true }
        : { valid: false, path, reason: "JSON numbers must be finite" };
    }

    if (typeof current !== "object") {
      return {
        valid: false,
        path,
        reason: `Unsupported JSON value type: ${typeof current}`
      };
    }

    if (ancestors.has(current)) {
      return { valid: false, path, reason: "JSON values cannot contain cycles" };
    }

    ancestors.add(current);

    if (Array.isArray(current)) {
      for (const [index, item] of current.entries()) {
        const result = inspect(item, `${path}/${index}`);
        if (!result.valid) return result;
      }
      ancestors.delete(current);
      return { valid: true };
    }

    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      ancestors.delete(current);
      return {
        valid: false,
        path,
        reason: "JSON objects must be plain objects"
      };
    }

    for (const [key, item] of Object.entries(current)) {
      const escapedKey = key.replaceAll("~", "~0").replaceAll("/", "~1");
      const result = inspect(item, `${path}/${escapedKey}`);
      if (!result.valid) return result;
    }

    ancestors.delete(current);
    return { valid: true };
  }

  return inspect(value, "");
}

export function assertJsonValue(value: unknown, label = "value"): asserts value is JsonValue {
  const inspection = inspectJsonValue(value);
  if (!inspection.valid) {
    throw new TypeError(
      `${label} is not valid JSON at ${inspection.path || "/"}: ${inspection.reason}`
    );
  }
}

export function cloneJson<T extends JsonValue>(value: T): T {
  assertJsonValue(value);
  return structuredClone(value);
}
