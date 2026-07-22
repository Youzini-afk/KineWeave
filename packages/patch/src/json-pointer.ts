import { cloneJson, type JsonValue } from "@kineweave/protocol";

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export function escapeJsonPointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

export function parseJsonPointer(pointer: string): readonly string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new TypeError(`JSON Pointer must be empty or start with '/': ${pointer}`);
  }
  return pointer.slice(1).split("/").map((raw) => {
    if (/~(?:[^01]|$)/.test(raw)) {
      throw new TypeError(`Invalid JSON Pointer escape in ${pointer}`);
    }
    const decoded = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (FORBIDDEN_SEGMENTS.has(decoded)) {
      throw new TypeError(`Unsafe JSON Pointer segment: ${decoded}`);
    }
    return decoded;
  });
}

interface ParentLocation {
  readonly parent: JsonValue[] | Record<string, JsonValue>;
  readonly key: string;
}

function parentLocation(root: JsonValue, pointer: string): ParentLocation {
  const segments = parseJsonPointer(pointer);
  if (segments.length === 0) {
    throw new TypeError("Root JSON Pointer has no parent location");
  }

  let current: JsonValue = root;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(segment)) {
        throw new TypeError(`Invalid array index ${segment} in ${pointer}`);
      }
      const index = Number(segment);
      const next = current[index];
      if (next === undefined) throw new RangeError(`Missing path ${pointer}`);
      current = next;
      continue;
    }
    if (current !== null && typeof current === "object") {
      const next = current[segment];
      if (next === undefined) throw new RangeError(`Missing path ${pointer}`);
      current = next;
      continue;
    }
    throw new TypeError(`Cannot descend through a primitive at ${pointer}`);
  }

  if (Array.isArray(current)) {
    return { parent: current, key: segments.at(-1)! };
  }
  if (current !== null && typeof current === "object") {
    return { parent: current, key: segments.at(-1)! };
  }
  throw new TypeError(`Parent is not a container at ${pointer}`);
}

export function addAtPointer(
  root: JsonValue,
  pointer: string,
  value: JsonValue
): JsonValue {
  if (pointer === "") return cloneJson(value);
  const result = cloneJson(root);
  const { parent, key } = parentLocation(result, pointer);
  if (Array.isArray(parent)) {
    if (key === "-") {
      parent.push(cloneJson(value));
      return result;
    }
    if (!/^(0|[1-9]\d*)$/.test(key)) {
      throw new TypeError(`Invalid array index ${key}`);
    }
    const index = Number(key);
    if (index > parent.length) throw new RangeError(`Array index ${index} is out of range`);
    parent.splice(index, 0, cloneJson(value));
    return result;
  }
  parent[key] = cloneJson(value);
  return result;
}

export function removeAtPointer(root: JsonValue, pointer: string): JsonValue {
  if (pointer === "") {
    throw new TypeError("Removing the root requires document deletion semantics");
  }
  const result = cloneJson(root);
  const { parent, key } = parentLocation(result, pointer);
  if (Array.isArray(parent)) {
    if (!/^(0|[1-9]\d*)$/.test(key)) {
      throw new TypeError(`Invalid array index ${key}`);
    }
    const index = Number(key);
    if (index >= parent.length) throw new RangeError(`Array index ${index} is out of range`);
    parent.splice(index, 1);
    return result;
  }
  if (!(key in parent)) throw new RangeError(`Missing path ${pointer}`);
  delete parent[key];
  return result;
}

export function replaceAtPointer(
  root: JsonValue,
  pointer: string,
  value: JsonValue
): JsonValue {
  if (pointer === "") return cloneJson(value);
  const result = cloneJson(root);
  const { parent, key } = parentLocation(result, pointer);
  if (Array.isArray(parent)) {
    if (!/^(0|[1-9]\d*)$/.test(key)) {
      throw new TypeError(`Invalid array index ${key}`);
    }
    const index = Number(key);
    if (index >= parent.length) throw new RangeError(`Array index ${index} is out of range`);
    parent[index] = cloneJson(value);
    return result;
  }
  if (!(key in parent)) throw new RangeError(`Missing path ${pointer}`);
  parent[key] = cloneJson(value);
  return result;
}
