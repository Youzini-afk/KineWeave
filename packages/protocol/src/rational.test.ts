import { describe, expect, it } from "vitest";
import {
  addTime,
  divideRational,
  frameIndexToSeconds,
  rational,
  STANDARD_TIME_DOMAINS,
  timeValue
} from "./rational.js";

describe("Rational and TimeValue", () => {
  it("normalizes exact values", () => {
    expect(rational(50, -100)).toEqual({
      numerator: "-1",
      denominator: "2"
    });
  });

  it("does not drift across 30000 NTSC frames", () => {
    const oneFrame = frameIndexToSeconds(
      1,
      rational(30_000, 1_001)
    );
    let cursor = timeValue(rational(0), STANDARD_TIME_DOMAINS.seconds);
    for (let index = 0; index < 30_000; index += 1) {
      cursor = addTime(cursor, oneFrame);
    }
    expect(cursor.value).toEqual({ numerator: "1001", denominator: "1" });
  });

  it("requires explicit mapping across time domains", () => {
    expect(() =>
      addTime(
        timeValue(rational(1), STANDARD_TIME_DOMAINS.seconds),
        timeValue(rational(1), STANDARD_TIME_DOMAINS.frames)
      )
    ).toThrow(/mapping required/i);
  });

  it("divides exact rationals without converting through floating point", () => {
    expect(divideRational(rational(3, 4), rational(9, 10))).toEqual({
      numerator: "5",
      denominator: "6"
    });
  });
});
