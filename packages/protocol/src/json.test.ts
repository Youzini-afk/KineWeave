import { describe, expect, it } from "vitest";
import { inspectJsonValue } from "./json.js";

describe("JSON values", () => {
  it("rejects non-finite numbers and class instances", () => {
    expect(inspectJsonValue({ value: Number.NaN })).toMatchObject({
      valid: false,
      path: "/value"
    });
    expect(inspectJsonValue(new Date())).toMatchObject({ valid: false });
  });

  it("reports cycles without recursing forever", () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(inspectJsonValue(value)).toMatchObject({
      valid: false,
      path: "/self"
    });
  });
});
