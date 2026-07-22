import { describe, expect, it } from "vitest";
import { canonicalStringify } from "./canonical-json.js";

describe("canonical JSON", () => {
  it("sorts object keys recursively without reordering arrays", () => {
    expect(
      canonicalStringify({
        z: 1,
        a: { y: true, b: false },
        items: [{ z: 1, a: 2 }, "last", "first"]
      })
    ).toBe(
      '{\n  "a": {\n    "b": false,\n    "y": true\n  },\n  "items": [\n    {\n      "a": 2,\n      "z": 1\n    },\n    "last",\n    "first"\n  ],\n  "z": 1\n}\n'
    );
  });

  it("rejects values JSON cannot represent", () => {
    expect(() => canonicalStringify({ value: Number.POSITIVE_INFINITY }))
      .toThrow(/valid JSON/i);
  });
});
