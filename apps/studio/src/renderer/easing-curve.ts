import { canonicalStringify } from "@kineweave/project-format";
import type { JsonObject } from "@kineweave/protocol";
import {
  cubicBezierEasing,
  MAX_CUBIC_BEZIER_Y_MAGNITUDE,
  STANDARD_KEYFRAME_EASINGS
} from "@kineweave/standard-motion-document";

export { MAX_CUBIC_BEZIER_Y_MAGNITUDE };

export interface CubicBezierCurve {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export type CubicBezierCoordinate = keyof CubicBezierCurve;

export interface CubicBezierViewport {
  readonly minimumY: number;
  readonly maximumY: number;
}

export interface CubicBezierPlotPoint {
  readonly x: number;
  readonly y: number;
}

export const CUBIC_BEZIER_GRAPH = {
  width: 220,
  height: 132,
  paddingX: 16,
  paddingY: 12
} as const;

export const LINEAR_CUBIC_BEZIER: CubicBezierCurve = {
  x1: 0,
  y1: 0,
  x2: 1,
  y2: 1
};

export const EASING_PRESETS: Readonly<Record<string, JsonObject | null>> = {
  auto: null,
  linear: { kind: STANDARD_KEYFRAME_EASINGS.linear },
  hold: { kind: STANDARD_KEYFRAME_EASINGS.hold },
  ease: cubicBezierEasing(0.25, 0.1, 0.25, 1),
  "ease-in": cubicBezierEasing(0.42, 0, 1, 1),
  "ease-out": cubicBezierEasing(0, 0, 0.58, 1),
  "ease-in-out": cubicBezierEasing(0.42, 0, 0.58, 1)
};

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function easingSignature(easing: JsonObject | undefined): string {
  return easing === undefined ? "undefined" : canonicalStringify(easing);
}

export function easingPreset(easing: JsonObject | undefined): string {
  if (easing === undefined) return "auto";
  for (const [name, preset] of Object.entries(EASING_PRESETS)) {
    if (preset !== null && canonicalStringify(preset) === canonicalStringify(easing)) return name;
  }
  return "custom";
}

export function cubicBezierParameters(
  easing: JsonObject | undefined
): CubicBezierCurve | undefined {
  if (easing?.kind !== STANDARD_KEYFRAME_EASINGS.cubicBezier) return undefined;
  const { x1, y1, x2, y2 } = easing;
  return finiteNumber(x1) &&
    x1 >= 0 &&
    x1 <= 1 &&
    finiteNumber(y1) &&
    Math.abs(y1) <= MAX_CUBIC_BEZIER_Y_MAGNITUDE &&
    finiteNumber(x2) &&
    x2 >= 0 &&
    x2 <= 1 &&
    finiteNumber(y2) &&
    Math.abs(y2) <= MAX_CUBIC_BEZIER_Y_MAGNITUDE
    ? { x1, y1, x2, y2 }
    : undefined;
}

export function customCurveFromEasing(easing: JsonObject | undefined): CubicBezierCurve {
  return cubicBezierParameters(easing) ?? LINEAR_CUBIC_BEZIER;
}

export function cubicBezierEasingValue(curve: CubicBezierCurve): JsonObject {
  return cubicBezierEasing(curve.x1, curve.y1, curve.x2, curve.y2);
}

export function withCubicBezierCoordinate(
  curve: CubicBezierCurve,
  coordinate: CubicBezierCoordinate,
  value: number
): CubicBezierCurve {
  const normalized =
    coordinate === "x1" || coordinate === "x2"
      ? clamp(value, 0, 1)
      : clamp(value, -MAX_CUBIC_BEZIER_Y_MAGNITUDE, MAX_CUBIC_BEZIER_Y_MAGNITUDE);
  return { ...curve, [coordinate]: normalized };
}

export function sameCubicBezierCurve(left: CubicBezierCurve, right: CubicBezierCurve): boolean {
  return (
    left.x1 === right.x1 && left.y1 === right.y1 && left.x2 === right.x2 && left.y2 === right.y2
  );
}

export function cubicBezierViewport(curve: CubicBezierCurve): CubicBezierViewport {
  const minimum = Math.min(0, 1, curve.y1, curve.y2);
  const maximum = Math.max(0, 1, curve.y1, curve.y2);
  const padding = Math.max(1, maximum - minimum) * 0.08;
  return {
    minimumY: minimum - padding,
    maximumY: maximum + padding
  };
}

export function cubicBezierPlotPoint(
  x: number,
  y: number,
  viewport: CubicBezierViewport
): CubicBezierPlotPoint {
  const plotWidth = CUBIC_BEZIER_GRAPH.width - CUBIC_BEZIER_GRAPH.paddingX * 2;
  const plotHeight = CUBIC_BEZIER_GRAPH.height - CUBIC_BEZIER_GRAPH.paddingY * 2;
  return {
    x: CUBIC_BEZIER_GRAPH.paddingX + x * plotWidth,
    y:
      CUBIC_BEZIER_GRAPH.paddingY +
      ((viewport.maximumY - y) / (viewport.maximumY - viewport.minimumY)) * plotHeight
  };
}

export function cubicBezierControlAtPlotPoint(
  plotX: number,
  plotY: number,
  viewport: CubicBezierViewport
): CubicBezierPlotPoint {
  const plotWidth = CUBIC_BEZIER_GRAPH.width - CUBIC_BEZIER_GRAPH.paddingX * 2;
  const plotHeight = CUBIC_BEZIER_GRAPH.height - CUBIC_BEZIER_GRAPH.paddingY * 2;
  const x = clamp((plotX - CUBIC_BEZIER_GRAPH.paddingX) / plotWidth, 0, 1);
  const verticalProgress = (plotY - CUBIC_BEZIER_GRAPH.paddingY) / plotHeight;
  return {
    x,
    y: viewport.maximumY - verticalProgress * (viewport.maximumY - viewport.minimumY)
  };
}
