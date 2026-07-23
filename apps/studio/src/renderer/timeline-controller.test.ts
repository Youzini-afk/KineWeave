import { describe, expect, it } from "vitest";
import { easingPreset } from "./timeline-controller.js";

describe("TimelineController easing presets", () => {
  it("recognizes a persisted cubic-bezier regardless of object key order", () => {
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
});
