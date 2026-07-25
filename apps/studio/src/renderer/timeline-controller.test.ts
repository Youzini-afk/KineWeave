import { describe, expect, it } from "vitest";
import {
  CUBIC_BEZIER_GRAPH,
  cubicBezierControlAtPlotPoint,
  cubicBezierEasingValue,
  cubicBezierParameters,
  cubicBezierPlotPoint,
  cubicBezierViewport,
  customCurveFromEasing,
  easingPreset,
  LINEAR_CUBIC_BEZIER,
  MAX_CUBIC_BEZIER_Y_MAGNITUDE,
  withCubicBezierCoordinate
} from "./easing-curve.js";

describe("Timeline easing curves", () => {
  it("recognizes persisted presets regardless of object key order", () => {
    expect(
      easingPreset({
        kind: "cubic-bezier",
        x1: 0.42,
        x2: 0.58,
        y1: 0,
        y2: 1
      })
    ).toBe("ease-in-out");
  });

  it("keeps absent and non-preset easing states distinct", () => {
    expect(easingPreset(undefined)).toBe("auto");
    expect(easingPreset({ kind: "cubic-bezier", x1: 0.42, x2: 0.58, y1: 0, y2: 0.9 })).toBe(
      "custom"
    );
  });

  it("reads valid arbitrary curves and initializes other easings as linear", () => {
    const overshoot = { kind: "cubic-bezier", x1: 0.2, y1: -0.5, x2: 0.8, y2: 1.7 };
    expect(cubicBezierParameters(overshoot)).toEqual({ x1: 0.2, y1: -0.5, x2: 0.8, y2: 1.7 });
    expect(customCurveFromEasing({ kind: "linear" })).toEqual(LINEAR_CUBIC_BEZIER);
    expect(
      cubicBezierParameters({ kind: "cubic-bezier", x1: -0.2, y1: 0, x2: 1, y2: 1 })
    ).toBeUndefined();
  });

  it("constrains x coordinates while preserving finite overshoot y values", () => {
    const curve = { x1: 0.2, y1: 0, x2: 0.8, y2: 1 };
    expect(withCubicBezierCoordinate(curve, "x1", -3)).toEqual({ ...curve, x1: 0 });
    expect(withCubicBezierCoordinate(curve, "x2", 4)).toEqual({ ...curve, x2: 1 });
    expect(withCubicBezierCoordinate(curve, "y1", -2.5)).toEqual({ ...curve, y1: -2.5 });
    expect(withCubicBezierCoordinate(curve, "y2", Number.MAX_VALUE)).toEqual({
      ...curve,
      y2: MAX_CUBIC_BEZIER_Y_MAGNITUDE
    });
    expect(cubicBezierEasingValue(curve)).toEqual({
      kind: "cubic-bezier",
      x1: 0.2,
      y1: 0,
      x2: 0.8,
      y2: 1
    });
  });

  it("rejects non-finite persisted coordinates", () => {
    const curve = { x1: 0.2, y1: -0.4, x2: 0.8, y2: 1.2 };
    expect(
      cubicBezierParameters({ ...cubicBezierEasingValue(curve), y1: Number.NaN })
    ).toBeUndefined();
    expect(
      cubicBezierParameters({ ...cubicBezierEasingValue(curve), y2: Number.POSITIVE_INFINITY })
    ).toBeUndefined();
    expect(
      cubicBezierParameters({
        ...cubicBezierEasingValue(curve),
        y2: MAX_CUBIC_BEZIER_Y_MAGNITUDE + 1
      })
    ).toBeUndefined();
  });

  it("auto-ranges overshoot curves and round-trips graph coordinates", () => {
    const curve = { x1: 0.15, y1: -0.8, x2: 0.75, y2: 1.6 };
    const viewport = cubicBezierViewport(curve);
    expect(viewport.minimumY).toBeLessThan(-0.8);
    expect(viewport.maximumY).toBeGreaterThan(1.6);

    const plotted = cubicBezierPlotPoint(curve.x2, curve.y2, viewport);
    const restored = cubicBezierControlAtPlotPoint(plotted.x, plotted.y, viewport);
    expect(restored.x).toBeCloseTo(curve.x2);
    expect(restored.y).toBeCloseTo(curve.y2);

    expect(cubicBezierControlAtPlotPoint(-100, CUBIC_BEZIER_GRAPH.height + 100, viewport).x).toBe(
      0
    );
    expect(
      cubicBezierControlAtPlotPoint(
        CUBIC_BEZIER_GRAPH.width / 2,
        CUBIC_BEZIER_GRAPH.paddingY - 50,
        viewport
      ).y
    ).toBeGreaterThan(viewport.maximumY);
  });
});
