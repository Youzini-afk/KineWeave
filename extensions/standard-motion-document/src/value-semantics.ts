import type { JsonValue } from "@kineweave/protocol";
import {
  STANDARD_NODE_TYPES,
  STANDARD_VALUE_TYPES
} from "./model.js";

const COMMON_PROPERTY_VALUE_TYPES: Readonly<Record<string, string>> = {
  position: STANDARD_VALUE_TYPES.vector2,
  scale: STANDARD_VALUE_TYPES.vector2,
  anchor: STANDARD_VALUE_TYPES.vector2,
  rotation: STANDARD_VALUE_TYPES.number,
  opacity: STANDARD_VALUE_TYPES.number
};

const TEXT_PROPERTY_VALUE_TYPES: Readonly<Record<string, string>> = {
  content: STANDARD_VALUE_TYPES.string,
  fontSize: STANDARD_VALUE_TYPES.number,
  fill: STANDARD_VALUE_TYPES.color
};

export const STANDARD_CANVAS_BACKGROUND_VALUE_TYPE = STANDARD_VALUE_TYPES.color;

export function expectedStandardPropertyValueType(
  nodeType: string,
  property: string
): string | undefined {
  return (
    COMMON_PROPERTY_VALUE_TYPES[property] ??
    (nodeType === STANDARD_NODE_TYPES.text
      ? TEXT_PROPERTY_VALUE_TYPES[property]
      : undefined)
  );
}

export function isStandardInterpolatedValueType(valueType: string): boolean {
  return (
    valueType === STANDARD_VALUE_TYPES.number ||
    valueType === STANDARD_VALUE_TYPES.vector2 ||
    valueType === STANDARD_VALUE_TYPES.color
  );
}

export function standardValueIssue(
  valueType: string,
  value: JsonValue
): string | undefined {
  if (valueType === STANDARD_VALUE_TYPES.string) {
    return typeof value === "string" ? undefined : "must be a string";
  }
  if (valueType === STANDARD_VALUE_TYPES.number) {
    return typeof value === "number" && Number.isFinite(value)
      ? undefined
      : "must be a finite number";
  }
  if (valueType === STANDARD_VALUE_TYPES.vector2) {
    return Array.isArray(value) &&
      value.length === 2 &&
      value.every((item) => typeof item === "number" && Number.isFinite(item))
      ? undefined
      : "must be a two-element finite numeric vector";
  }
  if (valueType === STANDARD_VALUE_TYPES.color) {
    return typeof value === "string" && /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(value)
      ? undefined
      : "must be a #RRGGBB or #RRGGBBAA color";
  }
  return undefined;
}

export function standardPropertyValueIssue(
  nodeType: string,
  property: string,
  value: JsonValue
): string | undefined {
  const valueType = expectedStandardPropertyValueType(nodeType, property);
  if (valueType === undefined) return undefined;
  const typeIssue = standardValueIssue(valueType, value);
  if (typeIssue !== undefined) return typeIssue;
  if (property === "opacity" && typeof value === "number") {
    return value >= 0 && value <= 1 ? undefined : "must be between 0 and 1";
  }
  if (property === "fontSize" && typeof value === "number") {
    return value > 0 ? undefined : "must be positive";
  }
  return undefined;
}
