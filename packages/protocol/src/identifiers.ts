const NAMESPACED_ID_PATTERN =
  /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*(?:\/[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*)?$/;
const STABLE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const QUALIFIED_NAME_PATTERN =
  /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\/[a-z][a-z0-9-]*(?:[.-][a-z0-9-]+)*$/;

export function isNamespacedId(value: string): boolean {
  return NAMESPACED_ID_PATTERN.test(value);
}

export function assertNamespacedId(value: string, label = "namespaced id"): void {
  if (!isNamespacedId(value)) {
    throw new TypeError(`Invalid ${label}: ${value}`);
  }
}

export function isStableId(value: string): boolean {
  return STABLE_ID_PATTERN.test(value);
}

export function assertStableId(value: string, label = "stable id"): void {
  if (!isStableId(value)) {
    throw new TypeError(`Invalid ${label}: ${value}`);
  }
}

export function isExtensionId(value: string): boolean {
  return EXTENSION_ID_PATTERN.test(value);
}

export function assertExtensionId(value: string, label = "extension id"): void {
  if (!isExtensionId(value)) {
    throw new TypeError(`Invalid ${label}: ${value}`);
  }
}

export function isQualifiedName(value: string): boolean {
  return QUALIFIED_NAME_PATTERN.test(value);
}

export function assertQualifiedName(value: string, label = "qualified name"): void {
  if (!isQualifiedName(value)) {
    throw new TypeError(`Invalid ${label}: ${value}`);
  }
}
